// 全部まとめて起動: Ollama → VOICEVOX → Minecraftサーバー → AI住人 → マイク入力
//   node scripts/launch.js                  (start.bat から呼ばれる)
//   node scripts/launch.js --no-mic         マイク入力のウィンドウを開かない
//   node scripts/launch.js --agents Zundamon
// Ctrl+C で、住人 → サーバー (ワールドを保存して停止) の順に安全に止める。
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { findVoicevox, patchGeyserConfig, patchProperties, download, modrinthUrl, MC_VERSION } from './setup.js'
import { ensureJava } from './java.js'
import { datapackFiles } from '../src/society/display.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = f => argv.includes(f)
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
const cfg = loadConfig(ROOT)
if (opt('--port')) cfg.minecraft.port = Number(opt('--port'))
const log = (tag, m) => console.log(`${new Date().toTimeString().slice(0, 8)} [${tag}] ${m}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const win = process.platform === 'win32'
const T0 = Date.now()

async function httpOk (url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
}

function portOpen (port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.connect({ port, host })
    s.setTimeout(1500)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
    s.once('timeout', () => { s.destroy(); resolve(false) })
  })
}

async function waitFor (check, ms, label) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return true; await sleep(1000) }
  log('launch', `${label} の起動を待ちきれなかった`)
  return false
}

function startDetached (cmd, args, opts = {}) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts })
  p.on('error', e => log('launch', `${cmd} を起動できない: ${e.message}`))
  p.unref()
}

const children = { server: null, agents: null }
let stopping = false

async function main () {
  // 1. Ollama
  if (cfg.llm.provider === 'ollama' && !flag('--mock')) {
    const url = cfg.llm.url.replace(/\/$/, '') + '/api/tags'
    if (await httpOk(url)) log('ollama', '起動済み')
    else {
      log('ollama', '起動します…')
      startDetached('ollama', ['serve'])
      if (await waitFor(() => httpOk(url), 30000, 'Ollama')) log('ollama', 'OK')
    }
  }

  // 2. VOICEVOX
  let voice = cfg.voice?.enabled && !flag('--no-voice')
  if (voice) {
    const url = cfg.voice.url.replace(/\/$/, '') + '/version'
    if (!(await httpOk(url))) {
      const exe = findVoicevox()
      if (exe) {
        log('voice', 'VOICEVOX を起動します…')
        startDetached(exe, [])
        voice = await waitFor(() => httpOk(url), 90000, 'VOICEVOX')
      } else voice = false
    }
    log('voice', voice ? 'VOICEVOX OK' : 'VOICEVOX なし → 文字だけで動かす')
  }

  // 3. Minecraft サーバー
  const port = cfg.minecraft.port
  if (await portOpen(port)) log('server', `port ${port} で既に動いているサーバーを使う`)
  else await startServer()

  // 4. AI 住人
  const pass = []
  for (const k of ['--agents', '--minutes', '--model']) if (opt(k)) pass.push(k, opt(k))
  if (flag('--mock')) pass.push('--mock')
  if (opt('--port')) pass.push('--port', opt('--port'))
  if (voice) pass.push('--voice'); else pass.push('--no-voice')
  startAgents(pass)

  // 5. マイク入力 (別ウィンドウ)
  if (cfg.voice_input?.enabled !== false && !flag('--no-mic')) {
    const vdir = path.join(ROOT, 'voice_input')
    const vpy = win ? path.join(vdir, '.venv', 'Scripts', 'python.exe') : path.join(vdir, '.venv', 'bin', 'python')
    if (fs.existsSync(vpy)) {
      await sleep(4000)
      if (win) {
        // mic.bat 経由で新しいウィンドウに開く (エラーで閉じても画面が残るように pause 付き)
        const bat = path.join(vdir, 'mic.bat')
        const extra = opt('--mic-mode') ? ` --mode ${opt('--mic-mode')}` : ''
        const mp = spawn('cmd.exe', ['/c', `start "AI Society mic" "${bat}"${extra}`], { cwd: vdir, detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
        mp.on('error', e => log('mic', 'マイクのウィンドウを開けなかった: ' + e.message + ' → voice_input\\mic.bat をダブルクリックして'))
        mp.unref()
        log('mic', '別ウィンドウでマイク入力を開いた (F9 を押しながら話す)')
      } else log('mic', `別のターミナルで: cd voice_input && .venv/bin/python talk.py`)
    } else log('mic', 'Python環境がないのでマイクはオフ (setup.bat で作れる)')
  }
  log('launch', `準備完了 (起動まで${Math.round((Date.now() - T0) / 1000)}秒)。止めるときはこのウィンドウで Ctrl+C`)
}

// 住人のプロセスが落ちても、サーバーは止めずに住人だけ自動で再起動する
const restarts = []
function startAgents (pass) {
  log('launch', '住人を起動します')
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/main.js'), ...pass], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, AI_SOCIETY_LAUNCHED: '1' } })
  children.agents = p
  // 住人側からの「ゲーム内に表示して」の印 (@@TELLRAW) をサーバーの操作画面に渡す
  let buf = ''
  p.stdout.on('data', d => {
    buf += d
    const lines = buf.split(/\r?\n/); buf = lines.pop()
    for (const line of lines) {
      if (line.startsWith('@@CMD ')) {
        // 住人側からのサーバーコマンド (表示用: tellraw / text_display / team のみ許可)
        const cmd = line.slice(6).replace(/[\r\n]/g, '')
        if (/^(tellraw|execute at \w+ run summon text_display|data merge entity @e\[type=text_display|kill @e\[type=text_display|team (add|modify|join) ais)/.test(cmd) && children.server && children.server.exitCode == null) {
          try { children.server.stdin.write(cmd + '\n') } catch {}
        }
      } else process.stdout.write(line + '\n')
    }
  })
  p.on('exit', code => {
    if (stopping) return
    const now = Date.now()
    while (restarts.length && now - restarts[0] > 10 * 60000) restarts.shift()
    if (code !== 0 && restarts.length < 5) {
      restarts.push(now)
      log('launch', `住人のプロセスが異常終了 (${code})。サーバーは動かしたまま、10秒後に住人だけ再起動します (${restarts.length}/5)`)
      setTimeout(() => !stopping && startAgents(pass), 10000)
    } else {
      log('launch', `住人のプロセスが終了 (${code})${code !== 0 ? '。10分間に何度も落ちたので止めます。この画面を送って' : ''}`)
      shutdown()
    }
  })
}

// ---- スキン: skins/<キャラのファイル名>.png を、住人がワールドに入ったときに着せる ----
// オフラインモードではスキンを直接持てないので SkinsRestorer (サーバーのプラグイン) に任せる。
// 画像は GitHub に公開されているこのフォルダのURLから読み込まれる (MineSkin で署名されて Minecraft に表示される)
function skinFiles () {
  const dir = path.join(ROOT, 'skins')
  const map = {}
  if (cfg.skins?.enabled === false || !fs.existsSync(dir)) return map
  const cdir = path.join(ROOT, cfg.characters_dir || 'characters')
  for (const f of fs.readdirSync(cdir).filter(f => f.endsWith('.json'))) {
    const base = f.replace(/\.json$/, '')
    try {
      const u = JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8')).username
      if (fs.existsSync(path.join(dir, base + '.png'))) map[u] = base
    } catch {}
  }
  return map
}

function skinBaseUrl () {
  if (cfg.skins?.base_url) return cfg.skins.base_url.replace(/\/$/, '')
  const git = args => { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: win }); return r.status === 0 ? r.stdout.trim() : '' }
  const remote = git(['remote', 'get-url', 'origin'])
  const m = remote.match(/github\.com[/:]([^/]+)\/([^/.]+?)(\.git)?$/)
  const rev = git(['rev-parse', 'HEAD'])
  if (!m || !rev) return null
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${rev}/${git(['rev-parse', '--show-prefix'])}skins`
}

async function ensureSkinsRestorer (srv) {
  const f = path.join(srv, 'plugins', 'SkinsRestorer.jar')
  if (fs.existsSync(f)) return true
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    log('server', 'スキン用のプラグイン SkinsRestorer をダウンロード中…')
    const size = await download(await modrinthUrl('skinsrestorer', MC_VERSION), f)
    log('server', `SkinsRestorer OK (${Math.round(size / 1e6)}MB)`)
    return true
  } catch (e) {
    log('server', `SkinsRestorer のダウンロードに失敗 (スキンなしで続ける): ${e.message}`)
    return false
  }
}

async function startServer () {
  const srv = path.join(ROOT, 'server')
  const custom = opt('--server-cmd') // テスト用 (例: "node scripts/test-server.js")
  let cmd; let args
  if (custom) { [cmd, ...args] = custom.split(' ') } else {
    if (!fs.existsSync(path.join(srv, 'paper.jar'))) { log('server', 'server/paper.jar が無い → 先に setup.bat を実行して'); process.exit(1) }
    const mem = cfg.minecraft.server_memory_gb || 3
    let java
    try { java = await ensureJava(21, m => log('server', m)) } catch (e) {
      log('server', `Java 21 を用意できなかった: ${e.message}`)
      log('server', '→ https://adoptium.net/ から「Temurin 21」を入れてから、もう一度起動して')
      await sleep(1000); process.exit(1)
    }
    log('server', `Java ${java.major} を使う: ${java.cmd}`)
    cmd = java.cmd; args = [`-Xms1G`, `-Xmx${mem}G`, '-jar', 'paper.jar', 'nogui']
  }
  // 頭上の名前・吹き出しを住人に追従させるデータパックを入れる
  if (!custom && cfg.display?.enabled !== false) {
    try {
      const names = fs.readdirSync(path.join(ROOT, cfg.characters_dir || 'characters')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(ROOT, cfg.characters_dir || 'characters', f), 'utf8')).username)
      const dp = path.join(srv, 'world', 'datapacks', 'ais')
      for (const [rel, body] of Object.entries(datapackFiles(names))) {
        const f = path.join(dp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body)
      }
    } catch (e) { log('server', '頭上表示のデータパックを書けなかった: ' + e.message) }
  }
  // 裏のコマンド(吹き出し・名前表示)の結果がOPのチャットに流れてうるさいので止める (setup をやり直さなくても効くよう毎回直す)
  if (!custom) {
    try {
      const pf = path.join(srv, 'server.properties')
      if (fs.existsSync(pf)) {
        const t = fs.readFileSync(pf, 'utf8')
        const fixed = patchProperties(t, { 'broadcast-console-to-ops': 'false' })
        if (fixed !== t) fs.writeFileSync(pf, fixed)
      }
    } catch (e) { log('server', 'server.properties を直せなかった: ' + e.message) }
  }
  const firstWorld = !fs.existsSync(path.join(srv, 'world', 'level.dat'))
  const skins = !custom ? skinFiles() : {}
  const skinUrl = Object.keys(skins).length && await ensureSkinsRestorer(srv) ? skinBaseUrl() : null
  if (Object.keys(skins).length && !skinUrl) log('server', 'スキンの画像URLが作れなかった (git が無い?) → スキンなしで続ける')
  const skinned = new Set()
  log('server', `Minecraftサーバーを起動します (${custom || 'Paper'})…${firstWorld ? ' 初回はワールド生成で数分かかる' : ''}`)
  fs.mkdirSync(path.join(srv, 'logs'), { recursive: true })
  const out = fs.createWriteStream(path.join(srv, 'logs', 'launch.log'), { flags: 'a' })
  const p = spawn(cmd, args, { cwd: custom ? ROOT : srv, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MC_PORT: String(cfg.minecraft.port) } })
  children.server = p
  let done = false
  const tail = []
  const kitFile = path.join(srv, 'starter-kit-given.json')
  let kitGiven = []
  try { kitGiven = JSON.parse(fs.readFileSync(kitFile, 'utf8')) } catch {}
  const agentNames = new Set(fs.readdirSync(path.join(ROOT, cfg.characters_dir || 'characters')).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, cfg.characters_dir || 'characters', f), 'utf8')).username } catch { return null } }))
  const onLine = line => {
    out.write(line + '\n')
    // 住人が初めて参加したら、スターターキット(食料・道具・ベッド)を渡す
    const j = line.match(/: (\w+) joined the game/)
    if (j && agentNames.has(j[1]) && !kitGiven.includes(j[1]) && cfg.world?.starter_kit?.length) {
      kitGiven.push(j[1])
      fs.writeFileSync(kitFile, JSON.stringify(kitGiven))
      setTimeout(() => {
        for (const item of cfg.world.starter_kit) { try { p.stdin.write(`give ${j[1]} ${item}\n`) } catch {} }
        log('server', `${j[1]} にスターターキットを渡した`)
      }, 3000)
    }
    // 住人が入ったら、その住人のスキンを着せる (起動ごとに1回)
    if (j && skinUrl && skins[j[1]] && !skinned.has(j[1])) {
      skinned.add(j[1])
      const id = 'ais_' + skins[j[1]]
      setTimeout(() => { try { p.stdin.write(`sr createcustom ${id} ${skinUrl}/${skins[j[1]]}.png classic\n`) } catch {} }, 4000)
      setTimeout(() => { try { p.stdin.write(`skin set ${id} ${j[1]}\n`) } catch {} ; log('server', `${j[1]} にスキンを着せた`) }, 12000)
    }
    if (/SkinsRestorer|\[SR\]|MineSkin/i.test(line) && /error|fail|失敗|invalid|unknown|could not/i.test(line)) log('server', 'スキン: ' + line.replace(/^\[[\d:]+ /, '').slice(0, 200))
    tail.push(line); if (tail.length > 40) tail.shift()
    if (/Done \(|listening on/.test(line)) done = true
    if (/Done \(|ERROR|Exception|Geyser.*(Started|started)|joined the game|left the game|Failed|FAILED/.test(line)) log('server', line.replace(/^\[[\d:]+ /, '').slice(0, 200))
  }
  for (const s of [p.stdout, p.stderr]) {
    let buf = ''
    s.on('data', d => { buf += d; const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.forEach(onLine) })
  }
  p.on('error', e => log('server', `サーバーを起動できない: ${e.message}`))
  p.on('exit', code => {
    log('server', `サーバーが停止 (${code})`)
    children.server = null
    if (!stopping) {
      console.log('\n---------- サーバーの最後の出力 (原因はここ) ----------')
      for (const l of tail) console.log(l)
      console.log('-------------------------------------------------------')
      const all = tail.join('\n')
      if (/UnsupportedClassVersionError|class file version/.test(all)) log('ヒント', 'Java が古い。Java 21 を入れて')
      else if (/FAILED TO BIND|Address already in use|BindException/i.test(all)) log('ヒント', `ポート ${cfg.minecraft.port} を別のサーバーが使ってる。他のMinecraftサーバーを閉じて`)
      else if (/eula/i.test(all)) log('ヒント', 'eula.txt の同意がない → setup.bat をもう一度')
      else if (/Invalid or corrupt jarfile|Error: Unable to access jarfile|zip END header/i.test(all)) log('ヒント', 'paper.jar が壊れてる → server フォルダの paper.jar を消して setup.bat をもう一度')
      else if (/OutOfMemory|Could not reserve enough space/i.test(all)) log('ヒント', 'メモリ不足 → config/settings.local.json の minecraft.server_memory_gb を 2 に')
      log('launch', 'この画面をそのまま送ってくれれば原因を見るよ')
      shutdown()
    }
  })
  const ready = await waitFor(async () => done && await portOpen(cfg.minecraft.port), 10 * 60000, 'Minecraftサーバー')
  if (!ready) { shutdown(); return }
  // ワールドのルール: 死んでも持ち物を失わない / 初回は昼から始める
  if (cfg.world?.keep_inventory !== false) p.stdin.write('gamerule keepInventory true\n')
  if (cfg.world?.difficulty) p.stdin.write(`difficulty ${cfg.world.difficulty}\n`)
  // 誰か1人がベッドで寝たら夜を飛ばす (住人は夜になると自分から寝る)。0〜100 で変えられる
  if (cfg.world?.sleep_percentage != null) p.stdin.write(`gamerule playersSleepingPercentage ${cfg.world.sleep_percentage}\n`)
  // データパックを有効化 (初回はワールド作成後に見つかるので念のため)
  if (!custom && cfg.display?.enabled !== false) p.stdin.write('datapack enable "file/ais"\n')
  // プレイヤーにOP権限 (コマンドが使える)
  if (cfg.player?.name && cfg.world?.op_player !== false) { p.stdin.write(`op ${cfg.player.name}\n`); log('server', `${cfg.player.name} にOP権限を付けた (コマンドが使える)`) }
  const firstFlag = path.join(srv, 'first-start-done')
  if (cfg.world?.start_at_day !== false && !fs.existsSync(firstFlag)) { p.stdin.write('time set day\n'); fs.writeFileSync(firstFlag, String(Date.now())); log('server', '初回なので昼にした') }
  // 初回だけ: Geyser の設定を「統合版は Floodgate(Xbox認証)で入る」にして再読み込み
  const gcfg = path.join(srv, 'plugins', 'Geyser-Spigot', 'config.yml')
  if (fs.existsSync(gcfg)) {
    const y = fs.readFileSync(gcfg, 'utf8')
    const patched = patchGeyserConfig(y)
    if (patched !== y) { fs.writeFileSync(gcfg, patched); p.stdin.write('geyser reload\n'); log('server', 'Geyser を統合版(Floodgate)向けに設定した') }
  }
}

async function shutdown () {
  if (stopping) return
  stopping = true
  log('launch', '終了します…')
  if (children.agents && children.agents.exitCode == null) children.agents.kill('SIGINT')
  await sleep(1500)
  const s = children.server
  if (s && s.exitCode == null) {
    log('server', 'ワールドを保存して停止中…')
    try { s.stdin.write('stop\n') } catch {}
    const end = Date.now() + 60000
    while (s.exitCode == null && Date.now() < end) await sleep(500)
    if (s.exitCode == null) s.kill()
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
main().catch(e => { console.error(e); shutdown() })
