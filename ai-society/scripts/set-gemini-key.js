// ネットのAI (Gemini 無料枠) を使うための設定。APIキーを聞いて、使えるモデルから新しい Flash を選び、
// 試しに1回話しかけてから config/settings.local.json に保存する (このPCの中だけ。Gitに上がらない)。
//   node scripts/set-gemini-key.js
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { GEMINI_BASE, pickGeminiModel } from '../src/llm/client.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(ROOT, 'config/settings.local.json')
let local = {}
try { local = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}

console.log('Gemini の APIキーを貼り付けて Enter (AIza で始まる文字列)。')
console.log('キーは https://aistudio.google.com の「Get API key」で無料で作れる。キーは他の人に見せないでね。')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const key = (await rl.question('APIキー: ')).trim()
rl.close()
if (key.length < 20) { console.log('✘ キーが短すぎる。コピーし直してもう一度。'); process.exit(1) }
const headers = { 'content-type': 'application/json', 'x-goog-api-key': key }

let model = process.argv.find(a => a.startsWith('gemini-'))
if (!model) {
  console.log('使えるモデルを確認中…')
  try {
    const r = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers })
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    model = pickGeminiModel((await r.json()).models || [])
  } catch (e) { console.log('✘ モデル一覧を取れなかった: ' + e.message); console.log('  キーが正しいか確認して。'); process.exit(1) }
  if (!model) { console.log('✘ 使える Flash モデルが見つからなかった。'); process.exit(1) }
}
console.log(`${model} で試しに1回話しかけてみる…`)
try {
  const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ずんだもんの口調で「よろしく」と一言だけ。' }] }], generationConfig: { maxOutputTokens: 64 } })
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('')
  console.log('✔ 返事: ' + text.trim())
} catch (e) {
  console.log('✘ うまく話せなかった: ' + e.message)
  console.log('  設定は保存していない。このメッセージをそのまま送ってくれれば原因を見るよ。')
  process.exit(1)
}

local.llm = { ...(local.llm || {}), provider: 'gemini', model, api_key: key }
fs.writeFileSync(file, JSON.stringify(local, null, 2) + '\n')
console.log(`保存した。住人の頭は ${model} (Gemini 無料枠) になる。「AI Society 起動」で起動しなおしてね。`)
console.log('元のローカルAIに戻すときは localai.bat。')
