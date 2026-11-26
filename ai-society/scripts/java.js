// Java 21 以上を探す。PATH に古い Java (8 など) が先にあっても、新しい方を使うため。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RUNTIME_DIR = path.join(ROOT, 'runtime')

export function javaMajor (javaCmd) {
  const r = spawnSync(javaCmd, ['-version'], { encoding: 'utf8', windowsHide: true })
  if (r.error || r.status !== 0) return null
  const m = (r.stderr + r.stdout).match(/version "(\d+)(?:\.(\d+))?/)
  if (!m) return null
  const major = Number(m[1])
  return major === 1 ? Number(m[2]) : major // "1.8.0" → 8
}

function candidates () {
  const out = []
  // このアプリ専用にダウンロードした Java (ensureJava で入れたもの) を最優先
  let rt = []
  try { rt = fs.readdirSync(RUNTIME_DIR) } catch {}
  for (const e of rt) {
    out.push(path.join(RUNTIME_DIR, e, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))
    out.push(path.join(RUNTIME_DIR, e, 'Contents', 'Home', 'bin', 'java'))
  }
  if (process.env.JAVA_HOME) out.push(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean)
    const vendors = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Eclipse Foundation']
    for (const r of roots) {
      for (const v of vendors) {
        const dir = path.join(r, v)
        let entries = []
        try { entries = fs.readdirSync(dir) } catch { continue }
        for (const e of entries) out.push(path.join(dir, e, 'bin', 'java.exe'))
      }
    }
  } else {
    for (const dir of ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']) {
      let entries = []
      try { entries = fs.readdirSync(dir) } catch { continue }
      for (const e of entries) out.push(path.join(dir, e, 'bin', 'java'), path.join(dir, e, 'Contents', 'Home', 'bin', 'java'))
    }
  }
  return out.filter(f => fs.existsSync(f))
}

// { cmd, major } を返す。21以上が見つからなければ PATH の java (とそのバージョン)
export function findJava (minMajor = 21) {
  let best = null
  for (const c of candidates()) {
    const major = javaMajor(c)
    if (major && major >= minMajor && (!best || major > best.major)) best = { cmd: c, major }
  }
  if (best) return best
  const major = javaMajor('java')
  return { cmd: 'java', major }
}

// Java 21 が無ければ、このアプリ専用の Java 21 (Eclipse Temurin JRE) を runtime/ にダウンロードして使う。
// PC に入っている他の Java (Java 8 など) には触らない。管理者権限も不要。
export async function ensureJava (minMajor = 21, log = console.log) {
  const found = findJava(minMajor)
  if (found.major && found.major >= minMajor) return found
  const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform]
  const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch]
  if (!os || !arch) throw new Error(`この環境 (${process.platform}/${process.arch}) 用の Java は自動で入れられない`)
  const url = `https://api.adoptium.net/v3/binary/latest/${minMajor}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  const file = path.join(RUNTIME_DIR, `java${minMajor}.${ext}`)
  log(`Java ${minMajor} が無いので、このアプリ専用の Java ${minMajor} をダウンロードします (約50MB)…`)
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'ai-society-setup/0.1' } })
  if (!r.ok || !r.body) throw new Error(`Java のダウンロード失敗 HTTP ${r.status}`)
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(file))
  log('展開しています…')
  // Windows 10/11 の tar.exe は zip も展開できる
  // (Git の GNU tar が先に見つかると zip を扱えないので、Windows 標準の tar.exe を名指しで使う)
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const t = spawnSync(tar, ['-xf', file, '-C', RUNTIME_DIR], { stdio: 'inherit', windowsHide: true })
  fs.rmSync(file, { force: true })
  if (t.status !== 0) throw new Error('Java の展開に失敗')
  const after = findJava(minMajor)
  if (!after.major || after.major < minMajor) throw new Error('Java を入れたのに見つからない')
  log(`Java ${after.major} を用意した: ${after.cmd}`)
  return after
}
