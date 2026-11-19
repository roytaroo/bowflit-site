// VOICEVOX の話者とスタイル一覧を表示し、各キャラクターの voice 設定が見つかるか確認する
//   npm run voices                 一覧と確認
//   npm run voices -- ずんだもん こんにちは   その声で試しに読み上げ
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadCharacters } from '../src/config.js'
import { TTS } from '../src/voice/tts.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfg = loadConfig(ROOT)
const tts = new TTS({ ...cfg.voice, enabled: true, out_dir: path.join(ROOT, 'data/voice') })
const list = await tts.loadSpeakers()
console.log('■ VOICEVOX の話者 (名前: スタイル=ID)')
for (const sp of list) console.log(`  ${sp.name}: ` + sp.styles.map(s => `${s.name}=${s.id}`).join(', '))
console.log('■ キャラクターの声の確認')
const { all } = loadCharacters(ROOT, cfg)
for (const c of all) {
  const v = c.voice || {}
  if (v.engine === 'aquestalk') console.log(`  ${c.display_name}: ゆっくり(${v.preset}) ${cfg.voice.aquestalk?.command ? 'コマンド設定済み' : '※コマンド未設定 → 代わりに「' + (cfg.voice.aquestalk?.fallback_speaker_name || 'ずんだもん') + '」の声'}`)
  else {
    const id = tts.resolveSpeaker(v)
    console.log(`  ${c.display_name}: ${v.speaker_name}/${v.style || 'ノーマル'} → ${id == null ? '✘ 見つからない' : 'ID ' + id}`)
  }
}
const [who, ...words] = process.argv.slice(2)
if (who) {
  const c = all.find(x => x.display_name === who || x.username === who || (x.nicknames || []).includes(who))
  await tts.speak(c || { username: 'test', voice: { speaker_name: who } }, words.join(' ') || 'こんにちは。テストです。')
}
