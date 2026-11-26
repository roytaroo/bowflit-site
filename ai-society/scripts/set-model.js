// LLM のモデルを切り替える (config/settings.local.json に保存して ollama pull する)
//   node scripts/set-model.js light    軽量・速い (qwen3:4b)
//   node scripts/set-model.js normal   標準 (qwen2.5:7b-instruct)
//   node scripts/set-model.js <モデル名>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = process.argv[2] || 'light'
const model = { light: 'qwen3:4b', normal: 'qwen2.5:7b-instruct' }[arg] || arg
const file = path.join(ROOT, 'config/settings.local.json')
let local = {}
try { local = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
local.llm = { ...(local.llm || {}), provider: 'ollama', model, auto_light: arg !== 'normal' } // normal を選んだら自動切り替えもしない
fs.writeFileSync(file, JSON.stringify(local, null, 2) + '\n')
console.log(`モデルを ${model} にした。ダウンロードを確認します…`)
const r = spawnSync('ollama', ['pull', model], { stdio: 'inherit', shell: process.platform === 'win32' })
console.log(r.status === 0 ? '準備OK。「AI Society 起動」で起動しなおしてね。' : 'ollama pull に失敗した。Ollama が起動しているか確認して。')
