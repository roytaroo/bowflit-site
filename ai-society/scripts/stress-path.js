// 経路探索のメモリ調査用: 1人で採掘・探索を繰り返し、メモリ使用量を表示する
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
const cfg = loadConfig(ROOT, { minecraft: { port }, llm: { provider: 'mock' } })
const society = new Society({ store: new Store(':memory:'), llm: new LLMClient(cfg.llm, { mockProvider: new MockProvider() }), config: cfg })
const agent = new Agent({ username: 'Stress', display_name: 'ストレス', personality: 't', speech: 't', relationships: {} }, society)
agent._decideLoop = async () => {}; agent._replyLoop = async () => {}
await agent.start()
while (!agent.ready()) await sleep(500)
await sleep(3000)
let peak = 0
setInterval(() => { const m = process.memoryUsage().heapUsed / 1e6; peak = Math.max(peak, m) }, 200)
const run = async (name, args) => {
  const t = Date.now()
  let r
  try { r = await ACTIONS[name].run(agent._ctx(), args) } catch (e) { r = 'ERR ' + e.message }
  console.log(`${name} ${JSON.stringify(args)} ${((Date.now() - t) / 1000).toFixed(1)}s heap=${Math.round(process.memoryUsage().heapUsed / 1e6)}MB peak=${Math.round(peak)}MB :: ${r}`)
}
for (const b of ['stone', 'log', 'coal_ore', 'iron_ore']) await run('collect', { block: b, count: 16 })
for (const d of ['north', 'east', 'south', 'west']) await run('explore', { direction: d, distance: 96 })
await run('go_to', { x: 200, y: 64, z: 200 })
agent.stop(); await sleep(300); process.exit(0)
