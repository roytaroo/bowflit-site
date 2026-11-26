// 実際のMinecraftサーバーに1人だけ接続し、行動ツールを順番に直接実行して確認するスクリプト。
// LLMは使わない。 例: node scripts/smoke-actions.js --port 25565
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { Store } from '../src/memory/db.js'
import { LLMClient } from '../src/llm/client.js'
import { MockProvider } from '../src/llm/mock.js'
import { Society } from '../src/society/society.js'
import { Agent } from '../src/agent/agent.js'
import { ACTIONS } from '../src/agent/actions.js'
import { sleep } from '../src/util/log.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 25565
const cfg = loadConfig(ROOT, { minecraft: { port }, llm: { provider: 'mock' }, death: { permanent: false } })
const store = new Store(':memory:')
const society = new Society({ store, llm: new LLMClient(cfg.llm, { mockProvider: new MockProvider() }), config: cfg })
const ch = { username: 'Tester', display_name: 'テスター', personality: 'test', speech: 'test', relationships: {} }
const agent = new Agent(ch, society)
agent._decideLoop = async () => {} // 自動行動は止めて手動で実行
agent._replyLoop = async () => {}
await agent.start()
while (!agent.ready()) await sleep(500)
await sleep(2000)
const bot = agent.bot
const run = async (name, args = {}) => {
  const t = Date.now()
  try {
    const r = await ACTIONS[name].run(agent._ctx(), args)
    console.log(`OK   ${name.padEnd(14)} ${((Date.now() - t) / 1000).toFixed(1)}s  ${r}`)
  } catch (e) { console.log(`FAIL ${name.padEnd(14)} ${e.message}`) }
}
const cmd = async c => { bot.chat(c); await sleep(800) }

await run('set_home')
await run('collect', { block: 'grass_block', count: 3 })
await cmd('/give Tester cobblestone 64')
await cmd('/give Tester oak_log 4')
await cmd('/give Tester bread 3')
await cmd('/give Tester oak_sign 1')
await cmd('/give Tester poppy 2')
console.log('inventory:', bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', '))
await run('craft', { item: 'oak_planks', count: 8 })
await run('craft', { item: 'stick', count: 4 })
await run('craft', { item: 'crafting_table', count: 1 })
await run('craft', { item: 'wooden_pickaxe', count: 1 })
await run('wander', { radius: 6 })
await run('build_house', { size: 5 })
await run('go_home')
await cmd('/give Tester cobblestone 8')
await cmd('/give Tester oak_sign 1')
// お墓 (死亡記録を擬似的に作る)
store.run('INSERT INTO deaths (agent, cause, day, created_at) VALUES (?, ?, ?, ?)', 'Popo', 'was slain by Zombie', 1, Date.now())
await run('build_grave', { for: 'Popo', epitaph: 'ポポ ここに眠る 花が大好きだった' })
await run('visit_grave', { for: 'Popo' })
await run('rest', { seconds: 2 })
console.log('graves:', JSON.stringify(store.all('SELECT for_agent, x, y, z, epitaph FROM graves')))
console.log('protected:', store.all('SELECT owner, kind FROM protected_zones').map(z => `${z.owner}/${z.kind}`).join(', '))
// 死亡処理
await cmd('/kill Tester')
await sleep(3000)
console.log('deaths:', JSON.stringify(store.all('SELECT agent, cause FROM deaths')))
console.log('lessons:', agent.memory.lessons().map(m => m.content).join(' / '))
agent.stop()
await sleep(500)
process.exit(0)
