// 設定の読み込み。config/settings.json に config/settings.local.json (個人用・git管理外) を上書きマージする。
import fs from 'node:fs'
import path from 'node:path'

function deepMerge (a, b) {
  if (!b) return a
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v
  }
  return out
}

export function loadConfig (root = process.cwd(), overrides = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(root, 'config/settings.json'), 'utf8'))
  const localFile = path.join(root, 'config/settings.local.json')
  const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : null
  return deepMerge(deepMerge(base, local), overrides)
}

const REQUIRED = ['username', 'display_name', 'personality', 'speech']

export function loadCharacters (root, cfg) {
  const dir = path.join(root, cfg.characters_dir || 'characters')
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(f => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
  for (const c of all) {
    for (const k of REQUIRED) if (!c[k]) throw new Error(`${c.file}: ${k} がありません`)
    if (!/^[A-Za-z0-9_]{3,16}$/.test(c.username)) throw new Error(`${c.file}: username は英数字と_で3〜16文字にしてください (Minecraftの制限)`)
  }
  const names = new Set()
  for (const c of all) {
    if (names.has(c.username)) throw new Error(`username が重複: ${c.username}`)
    names.add(c.username)
  }
  // agents に名前の配列が指定されていればそれを、無ければ enabled: true のキャラを使う
  const selected = Array.isArray(cfg.agents) && cfg.agents.length
    ? all.filter(c => cfg.agents.includes(c.username))
    : all.filter(c => c.enabled)
  return { all, selected }
}
