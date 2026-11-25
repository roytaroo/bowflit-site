// Java 21 以上を探す。PATH に古い Java (8 など) が先にあっても、新しい方を使うため。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

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
