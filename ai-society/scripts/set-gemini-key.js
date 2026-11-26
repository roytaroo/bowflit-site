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

// 起動のときに1回だけ聞くモード (start.bat から): 何も入れずに Enter なら、もう聞かない
const askMode = process.argv.includes('--ask')
const askedFlag = path.join(ROOT, 'config/.gemini-asked')
if (askMode && (local.llm?.api_key || fs.existsSync(askedFlag))) process.exit(0)
if (askMode) {
  console.log('')
  console.log('====================================================')
  console.log(' 住人の頭を Gemini (無料) にする設定')
  console.log(' キーを貼り付けて Enter (貼り付けは右クリック)')
  console.log(' 今は使わないなら、何も入れずに Enter')
  console.log('====================================================')
}
console.log('Gemini の APIキーを貼り付けて Enter (AQ. や AIza で始まる文字列)。')
console.log('キーは https://aistudio.google.com の「Get API key」で無料で作れる。キーは他の人に見せないでね。')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const raw = await rl.question('APIキー: ')
rl.close()
// 貼り付けで混ざりがちな空白・改行・引用符・全角文字を取り除く
const key = raw.normalize('NFKC').replace(/[\s'"`]/g, '').replace(/[^\x21-\x7e]/g, '')
const fail = code => { process.exitCode = askMode ? 0 : code } // process.exit() は使わない (Windowsで変なエラーが出るため)

async function run () {
  if (askMode && !key) { fs.writeFileSync(askedFlag, 'skip'); console.log('今は使わない。あとで使うときは set-gemini-key.bat。'); return }
  if (key.length < 20) { console.log('✘ キーが短すぎる。コピーし直してもう一度。'); return fail(1) }
  // 確認用: キーの最初と最後の4文字と長さ (AI Studio の画面と見比べる)
  console.log(`入力されたキー: ${key.slice(0, 4)}…${key.slice(-4)} (${key.length}文字)`)
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': key }

  let model = process.argv.find(a => a.startsWith('gemini-'))
  if (!model) {
    console.log('使えるモデルを確認中…')
    try {
      const r = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers })
      if (r.ok) model = pickGeminiModel((await r.json()).models || [])
      else console.log(`  (モデル一覧は取れなかった: HTTP ${r.status}。gemini-flash-lite-latest で試す)`)
    } catch (e) { console.log('  (モデル一覧は取れなかった: ' + e.message + '。gemini-flash-lite-latest で試す)') }
    model = model || 'gemini-flash-lite-latest'
  }
  console.log(`${model} で試しに1回話しかけてみる…`)
  try {
    const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ずんだもんの口調で「よろしく」と一言だけ。' }] }], generationConfig: { maxOutputTokens: 64 } })
    })
    if (!r.ok) {
      const t = await r.text()
      if (/API key not valid|API_KEY_INVALID/i.test(t)) {
        console.log('✘ Google に「このキーは無効」と言われた。')
        console.log('  ・AI Studio の「API keys」の画面のキーと、上の「入力されたキー」の最初と最後の4文字・長さが合っているか見て')
        console.log('  ・キーを削除していたら、新しく作ったキーを使って')
        console.log('  ・作ったばかりのキーは、使えるようになるまで1〜2分かかることがある')
        return fail(1)
      }
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`)
    }
    const data = await r.json()
    const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('')
    console.log('✔ 返事: ' + text.trim())
  } catch (e) {
    console.log('✘ うまく話せなかった: ' + e.message)
    console.log('  設定は保存していない。このメッセージをそのまま送ってくれれば原因を見るよ。')
    return fail(1)
  }

  local.llm = { ...(local.llm || {}), provider: 'gemini', model, api_key: key }
  fs.writeFileSync(file, JSON.stringify(local, null, 2) + '\n')
  console.log(`保存した。住人の頭は ${model} (Gemini 無料枠) になる。`)
  console.log('元のローカルAIに戻すときは localai.bat。')
}

await run()
