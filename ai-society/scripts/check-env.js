// 環境チェック: Node.js / Ollama とモデル / VOICEVOX / Minecraftサーバー
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { loadConfig, loadCharacters } from '../src/config.js'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfg = loadConfig(ROOT)
const ok = m => console.log('  ✔ ' + m)
const ng = m => console.log('  ✘ ' + m)

console.log('■ Node.js')
const [maj, min] = process.versions.node.split('.').map(Number)
maj > 22 || (maj === 22 && min >= 13) ? ok(process.version) : ng(`${process.version} (22.13以上が必要: node:sqlite を使うため)`)

console.log('■ キャラクター')
try {
  const { all, selected } = loadCharacters(ROOT, cfg)
  ok(`${all.length}人定義 / 参加 ${selected.length}人: ${selected.map(c => c.display_name).join('、')}`)
} catch (e) { ng(e.message) }

console.log(`■ LLM (${cfg.llm.provider})`)
if (cfg.llm.provider === 'ollama') {
  try {
    const t0 = Date.now()
    const tags = await (await fetch(cfg.llm.url + '/api/tags')).json()
    const names = tags.models.map(m => m.name)
    ok(`Ollama 接続OK (${names.length}モデル)`)
    if (!names.some(n => n === cfg.llm.model || n === cfg.llm.model + ':latest')) ng(`モデル ${cfg.llm.model} が未取得 → ollama pull ${cfg.llm.model}`)
    else {
      const r = await fetch(cfg.llm.url + '/api/chat', { method: 'POST', body: JSON.stringify({ model: cfg.llm.model, stream: false, format: 'json', think: false, messages: [{ role: 'user', content: 'JSONで {"say":"挨拶"} を返して' }] }) })
      const d = await r.json()
      const tps = d.eval_count && d.eval_duration ? (d.eval_count / (d.eval_duration / 1e9)).toFixed(1) : '?'
      ok(`テスト応答 ${((Date.now() - t0) / 1000).toFixed(1)}秒 (初回はモデル読み込み込み) / 生成速度 ${tps} token/秒: ${d.message?.content?.slice(0, 60)}`)
      const ps = await (await fetch(cfg.llm.url + '/api/ps')).json()
      for (const m of ps.models || []) ok(`読み込み中: ${m.name} VRAM ${(m.size_vram / 1e9).toFixed(1)}GB / 全体 ${(m.size / 1e9).toFixed(1)}GB`)
    }
  } catch (e) { ng(`Ollamaに接続できない (${e.message})`) }
} else ok('ollama以外のプロバイダ: 接続は起動時に確認')

console.log('■ VOICEVOX')
try {
  const v = await (await fetch(cfg.voice.url + '/version')).text()
  ok(`ENGINE ${v} ${cfg.voice.enabled ? '(音声ON)' : '(settingsで voice.enabled=false)'}`)
} catch { (cfg.voice.enabled ? ng : ok)(`未起動 ${cfg.voice.enabled ? '(voice.enabled=true なのに接続できない)' : '(音声OFFなので問題なし)'}`) }

console.log('■ Minecraft サーバー')
try {
  const mc = require('minecraft-protocol')
  const r = await mc.ping({ host: cfg.minecraft.host, port: cfg.minecraft.port })
  ok(`${cfg.minecraft.host}:${cfg.minecraft.port} ${r.version?.name} / ${r.players?.online}人`)
  if (r.version?.name && cfg.minecraft.version && !String(r.version.name).includes(cfg.minecraft.version)) ng(`settings の version (${cfg.minecraft.version}) とサーバー (${r.version.name}) が違う`)
} catch (e) { ng(`${cfg.minecraft.host}:${cfg.minecraft.port} に接続できない (${e.message})`) }
process.exit(0)
