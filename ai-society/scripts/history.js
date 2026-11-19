// 世界の歴史を表示: 共有の出来事・日記・人間関係・お墓・計画
//   node scripts/history.js            全体
//   node scripts/history.js Haru       その人の日記・関係・最近の記憶
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { Store } from '../src/memory/db.js'
import { Relationships } from '../src/society/relationships.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfg = loadConfig(ROOT)
const dbArg = process.argv.indexOf('--db')
const store = new Store(path.resolve(ROOT, dbArg > 0 ? process.argv[dbArg + 1] : cfg.database))
const who = process.argv.slice(2).find((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--db')
const rel = new Relationships(store)

if (!who) {
  console.log('■ 世界の歴史')
  for (const e of store.all('SELECT * FROM shared_events ORDER BY id DESC LIMIT 40').reverse()) console.log(`  ${e.day != null ? e.day + '日目' : ''} [${e.kind}] ${e.content}`)
  console.log('■ お墓')
  for (const g of store.all('SELECT * FROM graves')) console.log(`  ${g.for_agent} (${g.x},${g.y},${g.z}) 「${g.epitaph}」 建てた人:${g.built_by}`)
  console.log('■ 計画')
  for (const p of store.all('SELECT * FROM projects ORDER BY id DESC LIMIT 15')) console.log(`  #${p.id} [${p.status}] ${p.title} (${p.proposed_by}) 参加:${p.members}`)
  console.log('■ 住人')
  for (const a of store.all('SELECT * FROM agents')) console.log(`  ${a.name} ${a.alive ? '' : '(永眠)'} 目標:${a.current_goal || '-'} / 夢:${a.long_goal || '-'} / 死亡${a.deaths}回 / 成長:${a.growth || '-'}`)
} else {
  const a = store.getAgent(who)
  if (!a) { console.log('その名前の住人はいない'); process.exit(1) }
  console.log(`■ ${who}  目標:${a.current_goal || '-'} / 夢:${a.long_goal || '-'} / 慎重さ${a.caution}`)
  console.log('■ 人間関係'); console.log(rel.describe(who))
  console.log('■ 日記')
  for (const d of store.all('SELECT * FROM diaries WHERE agent = ? ORDER BY day DESC LIMIT 7', who).reverse()) console.log(`  --- ${d.day}日目 ---\n  ${d.content.replace(/\n/g, '\n  ')}`)
  console.log('■ 教訓')
  for (const m of store.all("SELECT * FROM memories WHERE agent = ? AND kind = 'lesson' ORDER BY id DESC LIMIT 10", who)) console.log('  ' + m.content)
  console.log('■ 最近の記憶')
  for (const m of store.all('SELECT * FROM memories WHERE agent = ? AND archived = 0 ORDER BY id DESC LIMIT 20', who).reverse()) console.log(`  [${m.kind}] ${m.content}`)
}
store.close()
