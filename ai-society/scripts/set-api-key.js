// ネットのAI (Claude) を使うための設定。APIキーを聞いて、動くか試してから config/settings.local.json に保存する。
// settings.local.json はこのPCの中だけのファイル (Gitに上がらない・アップデートで消えない)。
//   node scripts/set-api-key.js            キーを入力して Claude に切り替え
//   node scripts/set-api-key.js --local    ローカル (Ollama) に戻す
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(ROOT, 'config/settings.local.json')
let local = {}
try { local = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
const save = () => fs.writeFileSync(file, JSON.stringify(local, null, 2) + '\n')

if (process.argv.includes('--local')) {
  local.llm = { ...(local.llm || {}), provider: 'ollama' }
  delete local.llm.model
  save()
  console.log('ローカルのAI (Ollama) に戻した。「AI Society 起動」で起動しなおしてね。')
  process.exit(0)
}

const model = process.argv.find(a => a.startsWith('claude-')) || 'claude-haiku-5-5'
console.log('Claude の APIキーを貼り付けて Enter (sk-ant- で始まる文字列)。')
console.log('キーは https://platform.claude.com の「API Keys」で作れる。キーは他の人に見せないでね。')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const key = (await rl.question('APIキー: ')).trim()
rl.close()
if (!/^sk-ant-/.test(key)) { console.log('✘ sk-ant- で始まっていない。コピーし直してもう一度。'); process.exit(1) }

console.log(`${model} で試しに1回話しかけてみる…`)
try {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: key, maxRetries: 1 })
  const res = await client.messages.create({
    model,
    max_tokens: 64,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'ずんだもんの口調で「よろしく」と一言だけ。' }]
  })
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('')
  console.log('✔ 返事: ' + text.trim())
} catch (e) {
  console.log('✘ うまく話せなかった: ' + (e.status ? `HTTP ${e.status} ` : '') + e.message)
  console.log('  キーが正しいか、クレジット(残高)が入っているか確認して。設定は保存していない。')
  process.exit(1)
}

local.llm = { ...(local.llm || {}), provider: 'anthropic', model, api_key: key }
save()
console.log('保存した。これで住人の頭はネットのAI (Claude) になる。「AI Society 起動」で起動しなおしてね。')
console.log('元のローカルAIに戻すときは localai.bat。')
