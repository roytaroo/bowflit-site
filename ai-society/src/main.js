// 起動スクリプト。
//   node src/main.js                 … settings.json の設定で起動 (enabled:true のキャラ)
//   node src/main.js --mock          … LLMなし (ダミー) で流れだけ確認
//   node src/main.js --agents Zundamon,Metan,Kiritan,Reimu
//   node src/main.js --minutes 10    … 指定分数で自動終了 (計測用)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadCharacters } from './config.js'
import { Store } from './memory/db.js'
import { LLMClient } from './llm/client.js'
import { MockProvider } from './llm/mock.js'
import { TTS } from './voice/tts.js'
import { startInputServer } from './voice/inputServer.js'
import { Society } from './society/society.js'
import { Agent } from './agent/agent.js'
import { makeDisplay } from './society/display.js'
import { log, sleep } from './util/log.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs (argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { a[k.slice(2)] = next; i++ } else a[k.slice(2)] = true
  }
  return a
}

async function checkOllama (cfg) {
  if (cfg.provider !== 'ollama') return
  try {
    const r = await fetch(cfg.url.replace(/\/$/, '') + '/api/tags')
    const data = await r.json()
    const models = (data.models || []).map(m => m.name)
    if (!models.some(m => m === cfg.model || m === cfg.model + ':latest')) {
      log.warn('main', `Ollamaにモデル ${cfg.model} がありません。 \`ollama pull ${cfg.model}\` を実行してください。 (インストール済み: ${models.join(', ') || 'なし'})`)
    } else log.info('main', `Ollama OK: ${cfg.model}`)
  } catch (e) {
    log.error('main', `Ollama (${cfg.url}) に接続できません: ${e.message}。Ollamaを起動するか --mock で試してください。`)
  }
}

// AI がグラボにどれだけ載っているか (100% が理想。低いと CPU で動いて遅くなる)
async function reportGpuShare (llmCfg, { quiet = false } = {}) {
  let worst = null
  try {
    const ps = await (await fetch(llmCfg.url.replace(/\/$/, '') + '/api/ps')).json()
    for (const m of ps.models || []) {
      const pct = m.size ? Math.round(m.size_vram / m.size * 100) : 0
      if (m.name === llmCfg.model || m.name === llmCfg.model + ':latest') worst = worst == null ? pct : Math.min(worst, pct)
      const msg = `AIのグラボ使用率: ${m.name} ${pct}% がグラボ上 (VRAM ${(m.size_vram / 1e9).toFixed(1)}GB / 全体 ${(m.size / 1e9).toFixed(1)}GB)`
      if (quiet) continue
      if (pct < 90) log.warn('main', msg + ' → グラボに入りきらず遅い')
      else log.info('main', msg)
    }
  } catch {}
  return worst
}

async function hasModel (base, name) {
  try {
    const tags = await (await fetch(base + '/api/tags')).json()
    return (tags.models || []).some(m => m.name === name || m.name === name + ':latest')
  } catch { return false }
}

// 軽量モデルに切り替える (重いモデルはグラボから降ろす)。次回からは最初から軽量モデルで起動
async function switchToLight (cfg, llm, store, light) {
  const lc = cfg.llm
  const base = lc.url.replace(/\/$/, '')
  const old = lc.model
  llm.setModel(light)
  store?.setState('auto_light_model', light)
  if (old !== light) fetch(base + '/api/generate', { method: 'POST', body: JSON.stringify({ model: old, keep_alive: 0 }) }).catch(() => {})
  try {
    const t0 = Date.now()
    await fetch(base + '/api/generate', { method: 'POST', body: JSON.stringify({ model: light, prompt: 'hi', stream: false, think: false, keep_alive: lc.keep_alive ?? '30m', options: { num_predict: 1 } }), signal: AbortSignal.timeout(300000) })
    log.info('main', `軽量モデル ${light} の準備OK (${((Date.now() - t0) / 1000).toFixed(0)}秒)`)
  } catch {}
  reportGpuShare(lc)
}

// 裏でダウンロードして、終わりしだい切り替える
function pullThenSwitch (cfg, llm, store, light, using) {
  const base = cfg.llm.url.replace(/\/$/, '')
  log.info('main', `${light} をダウンロード中 (数GB・数分)。終わるまでは ${using} で動く`)
  fetch(base + '/api/pull', { method: 'POST', body: JSON.stringify({ model: light, stream: false }), signal: AbortSignal.timeout(30 * 60000) })
    .then(r => r.ok ? switchToLight(cfg, llm, store, light) : log.warn('main', `${light} のダウンロードに失敗 (HTTP ${r.status})`))
    .catch(e => log.warn('main', `${light} のダウンロードに失敗: ${e.message}`))
}

// グラボに入りきらない (= 1回の考えに10秒以上かかる) なら、自動で軽いモデルに切り替える
async function autoLightModel (cfg, llm, store) {
  const lc = cfg.llm
  if (lc.provider !== 'ollama' || lc.auto_light === false) return
  const light = lc.light_model || 'qwen3:4b'
  if (lc.model === light) return
  const pct = await reportGpuShare(lc, { quiet: true })
  if (pct == null || pct >= 90) return
  log.warn('main', `${lc.model} がグラボに${pct}%しか入らず遅いので、軽量モデル ${light} に自動で切り替える (元に戻すなら normalmode.bat)`)
  if (await hasModel(lc.url.replace(/\/$/, ''), light)) return switchToLight(cfg, llm, store, light)
  pullThenSwitch(cfg, llm, store, light, lc.model)
}

export async function main (argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const overrides = {}
  if (args.mock) overrides.llm = { provider: 'mock' }
  if (args.model) overrides.llm = { ...(overrides.llm || {}), model: args.model }
  if (args.port || args.host || args.version) overrides.minecraft = { ...(args.port ? { port: Number(args.port) } : {}), ...(args.host ? { host: args.host } : {}), ...(args.version ? { version: args.version } : {}) }
  if (args.agents) overrides.agents = String(args.agents).split(',').map(s => s.trim())
  if (args.db) overrides.database = args.db
  if (args.voice) overrides.voice = { enabled: true }
  if (args['no-voice']) overrides.voice = { enabled: false }
  if (args['voice-in']) overrides.voice_input = { enabled: true }
  if (args['no-voice-in']) overrides.voice_input = { enabled: false }
  if (args.player) overrides.player = { name: args.player }
  const cfg = loadConfig(ROOT, overrides)
  const { selected } = loadCharacters(ROOT, cfg)
  if (!selected.length) throw new Error('参加するキャラクターがいません (characters/*.json の enabled か --agents を確認)')

  if (cfg.llm.provider === 'anthropic') {
    cfg.llm.concurrency = Math.max(cfg.llm.concurrency || 1, cfg.llm.cloud_concurrency ?? 4) // ネットのAIは同時にいくつも頼める
    if (!cfg.llm.api_key && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      log.error('main', 'ClaudeのAPIキーが設定されていない → set-api-key.bat を実行してキーを入れて')
    } else log.info('main', `ネットのAI: ${cfg.llm.model} (Claude) を使う`)
  }
  if (cfg.llm.provider === 'gemini') {
    cfg.llm.concurrency = Math.max(cfg.llm.concurrency || 1, 2)
    // 無料枠は1日の回数にも上限があるので、自分で考える間隔を長めに (仕事はルールで続く)
    cfg.agent = { ...(cfg.agent || {}), decide_interval_ms: Math.max(cfg.agent?.decide_interval_ms ?? 0, cfg.llm.decide_interval_ms ?? 30000) }
    if (!cfg.llm.api_key && !process.env.GEMINI_API_KEY) log.error('main', 'GeminiのAPIキーが設定されていない → set-gemini-key.bat を実行してキーを入れて')
    else log.info('main', `ネットのAI: ${cfg.llm.model} (Gemini 無料枠・1分あたり${cfg.llm.rpm ?? 10}回まで) を使う`)
  }
  const store = new Store(path.resolve(ROOT, cfg.database))
  const llm = new LLMClient(cfg.llm, { mockProvider: new MockProvider() })
  // ネットのAIの1日の予算 (円)。これを超えたらその日はAIに頼まない (住人はルールの仕事だけ続ける)
  if (cfg.llm.provider === 'anthropic') {
    const limitYen = cfg.llm.daily_budget_yen ?? 100
    llm.setBudget({ limitYen, store, onLimit: yen => log.warn('main', `今日のAIの予算 ${limitYen}円 に達した (約${Math.round(yen)}円)。今日はもうAIに頼まない。変えるなら set-api-key.bat の予算設定で`) })
    log.info('main', `AIの1日の予算: ${limitYen}円 (今日はここまで 約${Math.round(llm.budget.spent())}円)`)
  }
  await checkOllama(cfg.llm)
  // 前回グラボに入りきらず軽量モデルに切り替えたなら、今回は最初から軽量モデルで
  const remembered = store.getState('auto_light_model', null)
  let pullLight = null
  if (cfg.llm.provider === 'ollama' && cfg.llm.auto_light !== false && remembered) {
    // 軽量モデルの指定が変わっていたら (例: qwen2.5:3b → qwen3:4b)、入っていればそれを、無ければ今のを使いながら裏でダウンロード
    const want = cfg.llm.light_model || 'qwen3:4b'
    const use = want !== remembered && await hasModel(cfg.llm.url.replace(/\/$/, ''), want) ? want : remembered
    if (use !== remembered) store.setState('auto_light_model', use)
    if (use !== want) pullLight = want
    if (cfg.llm.model !== use) {
      log.info('main', `前回グラボに入りきらなかったので、最初から軽量モデル ${use} を使う (元に戻すなら normalmode.bat)`)
      llm.setModel(use)
    }
  }
  if (cfg.llm.provider === 'ollama') {
    // 最初の1回はモデルの読み込みで時間がかかるので、住人が考え始める前に読み込んでおく
    log.info('main', `LLMを準備中 (${cfg.llm.model} を読み込み中)…`)
    const t0 = Date.now()
    try {
      await fetch(cfg.llm.url.replace(/\/$/, '') + '/api/generate', { method: 'POST', body: JSON.stringify({ model: cfg.llm.model, prompt: 'hi', stream: false, keep_alive: cfg.llm.keep_alive ?? '30m', options: { num_predict: 1 } }), signal: AbortSignal.timeout(300000) })
      log.info('main', `LLM準備OK (${((Date.now() - t0) / 1000).toFixed(0)}秒)`)
      await reportGpuShare(cfg.llm)
      if (pullLight) pullThenSwitch(cfg, llm, store, pullLight, cfg.llm.model)
      else await autoLightModel(cfg, llm, store)
    } catch (e) { log.warn('main', 'LLMの準備に失敗: ' + e.message) }
  }
  const voice = new TTS({ ...cfg.voice, out_dir: path.resolve(ROOT, cfg.voice.out_dir || 'data/voice') })
  if (voice.enabled) {
    const v = await voice.check()
    if (v) {
      log.info('main', `VOICEVOX OK (version ${v})`)
      for (const c of selected) {
        if ((c.voice?.engine || 'voicevox') === 'voicevox' && voice.resolveSpeaker(c.voice || {}) == null) log.warn('main', `${c.display_name}: VOICEVOXに話者「${c.voice?.speaker_name}」が見つからない (npm run voices で確認して characters/*.json を直す)`)
        if (c.voice?.engine === 'aquestalk' && !cfg.voice.aquestalk?.command) log.warn('main', `${c.display_name}: ゆっくり音声のコマンドが未設定なので代わりの声で話します (voice.aquestalk.command)`)
      }
    } else { log.warn('main', 'VOICEVOXに接続できないため音声はOFFにします'); voice.enabled = false }
  }

  const society = new Society({ store, llm, config: cfg, voice })
  society.display = makeDisplay(cfg)
  society.seedRelationships(selected)
  society.applyProfileUpgrades(selected)
  const agents = selected.map(c => new Agent(c, society))
  society.bus.on('say', msg => { for (const a of agents) a.hearBot(msg) })
  society.display.setupTeam(agents.map(a => a.name))

  log.info('main', `参加者: ${agents.map(a => `${a.display}(${a.name})`).join(', ')} / LLM: ${cfg.llm.provider}${cfg.llm.provider !== 'mock' ? ' ' + cfg.llm.model : ''} / 同時処理 ${cfg.llm.concurrency}`)
  for (const a of agents) {
    await a.start()
    await sleep(cfg.minecraft.join_interval_ms ?? 4000) // サーバーの連続ログイン制限を避ける
  }

  // ゲーム内時間が取れないサーバー向けの日記タイマー (保険)
  const fallbackMin = cfg.diary?.fallback_interval_min ?? 20
  const fallback = setInterval(async () => {
    if (agents.some(a => a.bot?.time?.day != null)) return
    const d = store.getState('pseudo_day', 0)
    store.setState('pseudo_day', d + 1)
    for (const a of agents.filter(x => x.alive)) await a.writeDiary(d).catch(e => log.warn(a.name, e.message))
  }, fallbackMin * 60000)

  const inputServer = cfg.voice_input?.enabled ? startInputServer({ society, tts: voice, config: cfg }) : null

  // メモリの見張り: 住人プロセスのメモリが危なくなったら、落ちる前に全員の移動を止めて原因を記録
  const heapLimit = (await import('node:v8')).default.getHeapStatistics().heap_size_limit
  let lastWarn = 0
  const memWatch = setInterval(() => {
    const used = process.memoryUsage().heapUsed
    if (process.env.MEM_DEBUG) log.info('mem', `${Math.round(used / 1e6)}MB / ${Math.round(heapLimit / 1e6)}MB`)
    if (used > heapLimit * 0.6) {
      const doing = agents.map(a => `${a.name}:${a.currentAction?.name || '-'}`).join(' ')
      for (const a of agents) a.emergencyStop?.()
      if (Date.now() - lastWarn > 30000) { log.warn('mem', `メモリ使用が多い (${Math.round(used / 1e6)}MB/${Math.round(heapLimit / 1e6)}MB)。全員の移動を止めた。その時の行動: ${doing}`); lastWarn = Date.now() }
    }
  }, 2000)

  const stats = setInterval(() => { log.info('stats', llm.summary() + ` / メモリ ${Math.round(process.memoryUsage().heapUsed / 1e6)}MB`); if (cfg.llm.provider === 'ollama') reportGpuShare(cfg.llm) }, 2 * 60000)

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    log.info('main', '終了します… ' + llm.summary())
    clearInterval(fallback); clearInterval(stats); clearInterval(memWatch)
    inputServer?.close()
    for (const a of agents) { a.stop(); society.display.detach(a.character) }
    await sleep(500)
    store.close()
  }
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)))
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)))
  if (args.minutes) setTimeout(() => shutdown().then(() => process.exit(0)), Number(args.minutes) * 60000)
  return { society, agents, store, llm, voice, shutdown }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { log.error('main', e.stack || e.message); process.exit(1) })
}
