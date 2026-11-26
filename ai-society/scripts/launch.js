// 全部まとめて起動: Ollama → VOICEVOX → Minecraftサーバー → AI住人 → マイク入力
//   node scripts/launch.js                  (start.bat から呼ばれる)
//   node scripts/launch.js --no-mic         マイク入力のウィンドウを開かない
//   node scripts/launch.js --agents Zundamon
// Ctrl+C で、住人 → サーバー (ワールドを保存して停止) の順に安全に止める。
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { findVoicevox, patchGeyserConfig } from './setup.js'
import { ensureJava } from './java.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = f => argv.includes(f)
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
const cfg = loadConfig(ROOT)
if (opt('--port')) cfg.minecraft.port = Number(opt('--port'))
const log = (tag, m) => console.log(`${new Date().toTimeString().slice(0, 8)} [${tag}] ${m}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const win = process.platform === 'win32'

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
        spawn('cmd.exe', ['/c', 'start', '"AI Society mic"', vpy, 'talk.py', ...(opt('--mic-mode') ? ['--mode', opt('--mic-mode')] : [])], { cwd: vdir, detached: true, stdio: 'ignore' }).unref()
        log('mic', '別ウィンドウでマイク入力を開いた (F9 を押しながら話す)')
      } else log('mic', `別のターミナルで: cd voice_input && .venv/bin/python talk.py`)
    } else log('mic', 'Python環境がないのでマイクはオフ (setup.bat で作れる)')
  }
  log('launch', '準備完了。止めるときはこのウィンドウで Ctrl+C')
}

// 住人のプロセスが落ちても、サーバーは止めずに住人だけ自動で再起動する
const restarts = []
function startAgents (pass) {
  log('launch', '住人を起動します')
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/main.js'), ...pass], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
  children.agents = p
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
  log('server', `Minecraftサーバーを起動します (${custom || 'Paper'})… 初回はワールド生成で数分かかる`)
  fs.mkdirSync(path.join(srv, 'logs'), { recursive: true })
  const out = fs.createWriteStream(path.join(srv, 'logs', 'launch.log'), { flags: 'a' })
  const p = spawn(cmd, args, { cwd: custom ? ROOT : srv, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MC_PORT: String(cfg.minecraft.port) } })
  children.server = p
  let done = false
  const tail = []
  const onLine = line => {
    out.write(line + '\n')
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
