// 初回セットアップ (何度実行しても大丈夫)。
//   node scripts/setup.js              Java版で全自動 (名前はランチャーから読み取る。見つからない時だけ聞く)
//   node scripts/setup.js --bedrock    統合版からも入れるようにする (Geyser + Floodgate + ViaVersion)
//   node scripts/setup.js --yes        一切聞かずに既定値で進める
// やること:
//   1. PCのGPU(VRAM)・メモリを調べて、LLMのモデルとサーバーのメモリを決める
//   2. 自分の名前を調べて config/settings.local.json を作る
//   3. Minecraftサーバー (Paper) を server/ にダウンロードし、設定を書く
//   3b. ランチャーに 1.21.4 の起動構成、マルチプレイ一覧にこのサーバーを追加
//   4. ollama pull でモデルをダウンロード
//   5. マイク会話用の Python 環境 (voice_input/.venv) を作る
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findJava } from './java.js'
import { detectPlayerName, addLauncherProfile, addServerEntry, minecraftDir } from './client-setup.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MC_VERSION = '1.21.4'
const UA = 'ai-society-setup/0.1 (personal Minecraft AI project)'

// ------------------------------------------------------------ 判定 (テストできる純粋関数)
export function chooseModel (vramMiB) {
  if (vramMiB == null) return { model: 'qwen2.5:3b', concurrency: 1, note: 'NVIDIA GPU が見つからないので、CPUでも動く小さいモデルにした (遅い)' }
  if (vramMiB < 10000) return { model: 'qwen2.5:7b-instruct', concurrency: 1, note: `VRAM ${Math.round(vramMiB / 1024)}GB 向け` }
  if (vramMiB < 20000) return { model: 'qwen3:14b', concurrency: 3, note: `VRAM ${Math.round(vramMiB / 1024)}GB 向け (3人同時に考える)` }
  return { model: 'qwen3:14b', concurrency: 6, note: `VRAM ${Math.round(vramMiB / 1024)}GB 向け (6人同時に考える)` }
}

export function serverMemoryGB (totalBytes) {
  const gb = totalBytes / 1024 ** 3
  if (gb < 12) return 2
  if (gb < 24) return 3
  if (gb < 48) return 4
  return 6
}

// 統合版 (Geyser + Floodgate) で入ったときのサーバー上の名前: 先頭に "." が付き、空白は "_"
export function bedrockJavaName (gamertag) {
  return '.' + String(gamertag).trim().replace(/\s/g, '_')
}

export const SERVER_PROPERTIES = {
  'online-mode': 'false',            // AI はMicrosoftアカウントを持たないため
  'enforce-secure-profile': 'false', // オフラインのAIがチャットするのに必要
  'server-ip': '127.0.0.1',          // Java版の入口はこのPCの中だけ (外から直接入れない)
  'server-port': '25565',
  'spawn-protection': '0',
  'white-list': 'false',             // 入口がPC内と統合版(Xbox認証あり)だけなので不要
  difficulty: 'normal',
  gamemode: 'survival',
  'max-players': '20',
  'view-distance': '8',
  'simulation-distance': '8',
  motd: 'AI Society',
  'level-name': 'world'
}

export function patchProperties (text, values) {
  const lines = (text || '').split(/\r?\n/)
  const seen = new Set()
  const out = lines.map(l => {
    const m = l.match(/^([^#=\s][^=]*)=(.*)$/)
    if (m && m[1] in values) { seen.add(m[1]); return `${m[1]}=${values[m[1]]}` }
    return l
  })
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) out.push(`${k}=${v}`)
  return out.filter((l, i, a) => !(l === '' && i === a.length - 1)).join('\n') + '\n'
}

// Geyser の設定: 統合版の人は Floodgate (Xbox認証) で入る
export function patchGeyserConfig (yaml) {
  if (!yaml) return yaml
  return yaml.replace(/^(\s*auth-type:\s*).*$/m, '$1floodgate')
}

// ------------------------------------------------------------ ダウンロード
async function getJson (url) {
  const r = await fetch(url, { headers: { 'user-agent': UA } })
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return r.json()
}

async function download (url, file) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' })
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 10000) throw new Error(`${url} のファイルが小さすぎる (${buf.length} bytes)`)
  fs.writeFileSync(file + '.part', buf)
  fs.renameSync(file + '.part', file)
  return buf.length
}

const PLUGINS = [
  { name: 'Geyser-Spigot', file: 'Geyser-Spigot.jar', url: 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot', page: 'https://geysermc.org/download' },
  { name: 'Floodgate', file: 'floodgate-spigot.jar', url: 'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot', page: 'https://geysermc.org/download' },
  { name: 'ViaVersion', file: 'ViaVersion.jar', modrinth: 'viaversion', page: 'https://modrinth.com/plugin/viaversion' }
]

async function paperUrl (version) {
  const b = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds/latest`)
  const url = b?.downloads?.['server:default']?.url
  if (!url) throw new Error('Paper のダウンロードURLが見つからない')
  return { url, build: b.id }
}

async function modrinthUrl (slug) {
  const list = await getJson(`https://api.modrinth.com/v2/project/${slug}/version?loaders=${encodeURIComponent('["paper"]')}`)
  const v = list.find(x => x.version_type === 'release') || list[0]
  const f = v?.files?.find(x => x.primary) || v?.files?.[0]
  if (!f) throw new Error(`${slug} のファイルが見つからない`)
  return f.url
}

// ------------------------------------------------------------ 本体
const say = m => console.log(m)
const ok = m => console.log('  ✔ ' + m)
const ng = m => console.log('  ✘ ' + m)

function has (cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' })
  return r.status === 0 ? (r.stdout || r.stderr || '').trim() : null
}

function detectVramMiB () {
  const out = has('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'])
  if (!out) return null
  const n = Math.max(...out.split(/\r?\n/).map(Number).filter(x => !Number.isNaN(x)))
  return Number.isFinite(n) ? n : null
}

function readJson (file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

async function main () {
  const auto = process.argv.includes('--yes')
  const rl = auto ? null : readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (q, def) => {
    if (auto) return def
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim()
    return a || def
  }

  say('\n■ 1. PCを調べる')
  const vram = detectVramMiB()
  const pick = chooseModel(vram)
  const memGB = serverMemoryGB(os.totalmem())
  ok(`GPU VRAM: ${vram ? Math.round(vram / 1024) + 'GB' : '不明 (NVIDIA以外かドライバ未導入)'} / メモリ ${Math.round(os.totalmem() / 1024 ** 3)}GB / CPU ${os.cpus()[0]?.model || '?'} (${os.cpus().length}スレッド)`)
  ok(`LLM: ${pick.model} — ${pick.note}`)
  ok(`Minecraftサーバーのメモリ: ${memGB}GB`)
  if (vram && vram < 10000) say('  ※ 同じPCでMinecraftも遊ぶと、ゲームもGPUのメモリを使うので住人の反応が遅くなることがある。\n    遅すぎたら config/settings.local.json の llm.model を "qwen2.5:3b" に変えて (ollama pull qwen2.5:3b)')

  say('\n■ 2. 自分の設定')
  const localFile = path.join(ROOT, 'config/settings.local.json')
  const local = readJson(localFile)
  const edition = process.argv.includes('--bedrock') ? 'bedrock' : (local.player?.edition === 'bedrock' && !process.argv.includes('--java') ? 'bedrock' : 'java')
  let name
  if (edition === 'bedrock') {
    const tag = await ask('統合版のゲーマータグ (Xboxの名前)', local.player?.gamertag || 'Daiki')
    name = bedrockJavaName(tag)
    local.player = { ...(local.player || {}), edition, gamertag: tag, name }
  } else {
    const detected = detectPlayerName()
    if (detected) ok(`ランチャーからプレイヤー名を読み取った: ${detected}`)
    name = detected || local.player?.name || await ask('Java版のプレイヤー名 (ランチャーの右上に出ている名前)', 'Daiki')
    local.player = { ...(local.player || {}), edition, name }
  }
  local.player.display_name = local.player.display_name || 'だいき' // 住人からの呼ばれ方 (settings.local.json で変更可)
  local.llm = { ...(local.llm || {}), model: pick.model, concurrency: pick.concurrency }
  local.minecraft = { ...(local.minecraft || {}), version: MC_VERSION, server_memory_gb: memGB }
  local.voice = { ...(local.voice || {}), enabled: true }
  fs.writeFileSync(localFile, JSON.stringify(local, null, 2) + '\n')
  ok(`config/settings.local.json を保存 (サーバー上の名前: ${name})`)

  say('\n■ 3. Minecraftサーバー (Paper ' + MC_VERSION + (edition === 'bedrock' ? ' + Geyser + Floodgate + ViaVersion' : '') + ')')
  const java = findJava(21)
  if (!java.major) ng('Java が見つからない → Java 21 を入れてから、もう一度実行して')
  else if (java.major < 21) ng(`Java 21 以上が必要 (見つかったのは Java ${java.major})`)
  else ok(`Java ${java.major}: ${java.cmd}`)
  const srv = path.join(ROOT, 'server')
  fs.mkdirSync(path.join(srv, 'plugins'), { recursive: true })
  const jar = path.join(srv, 'paper.jar')
  if (fs.existsSync(jar)) ok('paper.jar はダウンロード済み')
  else {
    try {
      const p = await paperUrl(MC_VERSION)
      const size = await download(p.url, jar)
      ok(`Paper ${MC_VERSION} build ${p.build} (${Math.round(size / 1e6)}MB)`)
    } catch (e) { ng(`Paper のダウンロード失敗: ${e.message}\n     → https://papermc.io/downloads/paper から ${MC_VERSION} を手で落として server/paper.jar に置いて`) }
  }
  for (const pl of edition === 'bedrock' ? PLUGINS : []) {
    const f = path.join(srv, 'plugins', pl.file)
    if (fs.existsSync(f)) { ok(`${pl.name} はダウンロード済み`); continue }
    try {
      const url = pl.url || await modrinthUrl(pl.modrinth)
      const size = await download(url, f)
      ok(`${pl.name} (${Math.round(size / 1e6)}MB)`)
    } catch (e) { ng(`${pl.name} のダウンロード失敗: ${e.message}\n     → ${pl.page} から手で落として server/plugins/${pl.file} に置いて`) }
  }
  fs.writeFileSync(path.join(srv, 'eula.txt'), '# https://aka.ms/MinecraftEULA\neula=true\n')
  const propFile = path.join(srv, 'server.properties')
  fs.writeFileSync(propFile, patchProperties(fs.existsSync(propFile) ? fs.readFileSync(propFile, 'utf8') : '', SERVER_PROPERTIES))
  ok(`eula.txt / server.properties を設定 (このPCの中からだけ入れる${edition === 'bedrock' ? '。統合版は Geyser 経由で port 19132' : ''})`)

  if (edition === 'java') {
    say('\n■ 3b. Minecraft (Java版) 側の設定')
    say(`  (${minecraftDir()} を設定します。ランチャーとゲームは閉じておいて)`)
    const prof = addLauncherProfile(MC_VERSION)
    prof.ok ? ok(`ランチャーに起動構成「AI Society ${MC_VERSION}」${prof.already ? 'は追加済み' : 'を追加'}`) : ng(prof.reason)
    try {
      const sv = await addServerEntry('AI Society', '127.0.0.1')
      sv.ok ? ok(`マルチプレイに「AI Society」${sv.already ? 'は追加済み' : 'を追加'}`) : ng(sv.reason)
    } catch (e) { ng('サーバー一覧に追加できなかった: ' + e.message) }
  }

  say('\n■ 4. LLM のモデル')
  if (!has('ollama', ['--version'])) ng('Ollama が見つからない → Ollama を入れてから、もう一度実行して')
  else {
    say(`  ollama pull ${pick.model} (数GBあるので時間がかかる)…`)
    const r = spawnSync('ollama', ['pull', pick.model], { stdio: 'inherit', shell: process.platform === 'win32' })
    r.status === 0 ? ok(`${pick.model} 準備OK`) : ng('ollama pull に失敗。Ollama が起動しているか確認して、もう一度実行して')
  }

  say('\n■ 5. マイク会話 (Python)')
  const py = process.platform === 'win32' ? (has('py', ['-3', '--version']) ? ['py', '-3'] : ['python']) : ['python3']
  if (!has(py[0], [...py.slice(1), '--version'])) ng('Python が見つからない → マイク会話は後で (文字チャットでは話せる)')
  else {
    const venv = path.join(ROOT, 'voice_input', '.venv')
    const vpy = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python')
    if (!fs.existsSync(vpy)) spawnSync(py[0], [...py.slice(1), '-m', 'venv', venv], { stdio: 'inherit', shell: process.platform === 'win32' })
    const r = spawnSync(vpy, ['-m', 'pip', 'install', '-q', '-r', path.join(ROOT, 'voice_input', 'requirements.txt')], { stdio: 'inherit' })
    r.status === 0 ? ok('voice_input/.venv に必要なものを入れた (Whisperのモデルは初回起動時にダウンロード)') : ng('pip install に失敗')
  }

  say('\n■ 6. VOICEVOX')
  const vv = findVoicevox()
  vv ? ok(`見つかった: ${vv}`) : ng('VOICEVOX が見つからない → https://voicevox.hiroshiba.jp/ から入れると声で話す (無くても文字で動く)')

  say('\n完了! 次は start.bat (Mac/Linux は npm run launch) で全部起動できる。')
  if (edition === 'java') say(`起動したら、ランチャーで「AI Society ${MC_VERSION}」を選んでプレイ → マルチプレイ → 「AI Society」に入ってね。`)
  if (edition === 'bedrock') say(`統合版の「サーバー」タブで、アドレス ${lanAddress() || 'このPCのIPアドレス'} / ポート 19132 を追加して入ってね。\n初回に Windows のファイアウォールの確認が出たら「許可」を押して。`)
  rl?.close()
}

export function findVoicevox () {
  const cands = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'VOICEVOX', 'VOICEVOX.exe'), 'C:\\Program Files\\VOICEVOX\\VOICEVOX.exe']
    : ['/Applications/VOICEVOX.app/Contents/MacOS/VOICEVOX']
  return cands.find(f => f && fs.existsSync(f)) || null
}

export function lanAddress () {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(i.address)) return i.address
  }
  return null
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1) })
}
