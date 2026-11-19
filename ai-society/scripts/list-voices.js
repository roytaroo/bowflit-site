// VOICEVOX の話者とスタイルID一覧を表示 (characters/*.json の voice.speaker に使う)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { VoiceVox } from '../src/voice/voicevox.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfg = loadConfig(ROOT)
const vv = new VoiceVox({ ...cfg.voice, enabled: true, out_dir: path.join(ROOT, 'data/voice') })
const list = await vv.speakers()
for (const sp of list) console.log(`${sp.name}: ` + sp.styles.map(s => `${s.name}=${s.id}`).join(', '))
if (process.argv[2]) {
  const [id, ...words] = process.argv.slice(2)
  vv.speak({ username: 'test', voice: { speaker: Number(id) } }, words.join(' ') || 'こんにちは。テストです。')
}
