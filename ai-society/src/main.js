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

export async function main (argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const overrides = {}
  if (args.mock) overrides.llm = { provider: 'mock' }
  if (args.model) overrides.llm = { ...(overrides.llm || {}), model: args.model }
  if (args.port || args.host || args.version) overrides.minecraft = { ...(args.port ? { port: Number(args.port) } : {}), ...(args.host ? { host: args.host } : {}), ...(args.version ? { version: args.version } : {}) }
  if (args.agents) overrides.agents = String(args.agents).split(',').map(s => s.trim())
  if (args.db) overrides.database = args.db
  if (args.voice) overrides.voice = { enabled: true }
  if (args['voice-in']) overrides.voice_input = { enabled: true }
  if (args['no-voice-in']) overrides.voice_input = { enabled: false }
  if (args.player) overrides.player = { name: args.player }
  const cfg = loadConfig(ROOT, overrides)
  const { selected } = loadCharacters(ROOT, cfg)
  if (!selected.length) throw new Error('参加するキャラクターがいません (characters/*.json の enabled か --agents を確認)')

  const store = new Store(path.resolve(ROOT, cfg.database))
  const llm = new LLMClient(cfg.llm, { mockProvider: new MockProvider() })
  await checkOllama(cfg.llm)
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
  society.seedRelationships(selected)
  const agents = selected.map(c => new Agent(c, society))
  society.bus.on('say', msg => { for (const a of agents) a.hearBot(msg) })

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

  const stats = setInterval(() => log.info('stats', llm.summary()), 5 * 60000)

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    log.info('main', '終了します… ' + llm.summary())
    clearInterval(fallback); clearInterval(stats)
    inputServer?.close()
    for (const a of agents) a.stop()
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
