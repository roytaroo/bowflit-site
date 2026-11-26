// 本物のサーバーで「体」だけを試す (LLMなし)。
//   node scripts/test-body.js --port 25566 [--fifo /path/to/server-console-fifo] [--steps logs,table,wpick,stone,spick,hut]
// --fifo を渡すと、毎回まっさらな状態 (持ち物を空に・ランダムな場所へ移動) から始める
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { Body } from '../src/body/body.js'
import * as plan from '../src/body/plan.js'
import * as skills from '../src/body/skills.js'
import { BODY_ACTIONS } from '../src/agent/bodyActions.js'

const require = createRequire(import.meta.url)
const mineflayer = require('mineflayer')
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const port = Number(opt('--port', 25566))
const fifo = opt('--fifo', null)
const name = opt('--name', 'Tester')
const steps = opt('--steps', 'logs,table,wpick,stone,spick,hut').split(',')
const cmd = c => { if (fifo) fs.appendFileSync(fifo, c + '\n') }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: name, version: '1.21.4', auth: 'offline', checkTimeoutInterval: 60000 })
Body.prepare(bot)
bot.on('kicked', r => console.log('KICKED', JSON.stringify(r).slice(0, 200)))
bot.on('error', e => console.log('ERROR', e.message))

bot.once('spawn', async () => {
  const body = new Body(bot, { onModeSay: m => console.log(`  [mode] ${m}`) })
  if (process.env.DEBUG_INT) { const ri = body.requestInterrupt.bind(body); body.requestInterrupt = () => { console.log('  [interrupt] by', new Error().stack.split('\n').slice(2, 5).map(l => l.trim().replace(/.*\//, '')).join(' < ')); ri() } }
  if (fifo) {
    const x = Math.round((Math.random() - 0.5) * 2000); const z = Math.round((Math.random() - 0.5) * 2000)
    cmd(`clear ${name}`); cmd(`effect clear ${name}`); cmd('time set day')
    cmd(`spreadplayers ${x} ${z} 0 10 false ${name}`)
    await sleep(6000)
  }
  await bot.waitForChunksToLoad().catch(() => {})
  const p = bot.entity.position
  console.log(`START at ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`)
  const results = []
  const step = async (label, fn) => {
    const t = Date.now()
    const r = await body.run(label, fn, { timeout: 5 })
    const ok = r.success && r.value !== false
    results.push([label, ok, ((Date.now() - t) / 1000).toFixed(0) + 's'])
    const msg = (r.message || '').replace(/\s+/g, ' ')
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${((Date.now() - t) / 1000).toFixed(0)}s ${ok ? '' : msg.slice(0, 200) + ' … ' + msg.slice(-200)}`)
    return ok
  }
  for (const s of steps) {
    if (s === 'logs') await step('原木を8本集める', () => plan.obtain(bot, 'log', 8))
    if (s === 'table') await step('作業台を作る', () => plan.obtain(bot, 'crafting_table', 1))
    if (s === 'wpick') await step('木のツルハシを作る', () => plan.obtain(bot, 'wooden_pickaxe', 1))
    if (s === 'stone') await step('丸石を20個集める', () => plan.obtain(bot, 'cobblestone', 20))
    if (s === 'spick') await step('石のツルハシを作る', () => plan.obtain(bot, 'stone_pickaxe', 1))
    if (s === 'hut') {
      // 住人と同じ「家を建てる」行動で (建材が足りなければ集めるところから)
      const agent = { name, home: null, houseSite: null, setHome (p) { this.home = p }, society: { isAgent: () => false, resolveName: n => n } }
      const ctx = { bot, agent, body, store: null }
      for (let k = 0; k < 4; k++) {
        let msg = ''
        const ok = await step(`家を建てる(${k + 1}回目)`, async () => { msg = await BODY_ACTIONS.build_house.run(ctx, {}); return true })
        console.log('   → ' + msg)
        if (/完成/.test(msg) || !ok) break
      }
    }
  }
  console.log('RESULT ' + results.map(([l, ok, t]) => `${ok ? '○' : '×'}${l}(${t})`).join(' '))
  console.log('INVENTORY ' + bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', '))
  body.stop()
  bot.quit()
  setTimeout(() => process.exit(0), 500)
})
