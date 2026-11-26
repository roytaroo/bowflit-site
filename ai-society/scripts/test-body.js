// 本物のサーバーで「体」だけを試す (LLMなし)。
//   node scripts/test-body.js --port 25566 [--fifo /path/to/server-console-fifo] [--steps logs,table,wpick,stone,spick,hut]
// --fifo を渡すと、毎回まっさらな状態 (持ち物を空に・ランダムな場所へ移動) から始める
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { Body } from '../src/body/body.js'
import * as plan from '../src/body/plan.js'
import * as skills from '../src/body/skills.js'

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
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${((Date.now() - t) / 1000).toFixed(0)}s ${ok ? '' : (r.message || '').replace(/\s+/g, ' ').slice(-300)}`)
    return ok
  }
  for (const s of steps) {
    if (s === 'logs') await step('原木を8本集める', () => plan.obtain(bot, 'log', 8))
    if (s === 'table') await step('作業台を作る', () => plan.obtain(bot, 'crafting_table', 1))
    if (s === 'wpick') await step('木のツルハシを作る', () => plan.obtain(bot, 'wooden_pickaxe', 1))
    if (s === 'stone') await step('丸石を20個集める', () => plan.obtain(bot, 'cobblestone', 20))
    if (s === 'spick') await step('石のツルハシを作る', () => plan.obtain(bot, 'stone_pickaxe', 1))
    if (s === 'hut') {
      await step('小屋を建てる', async () => {
        await plan.obtain(bot, 'planks', 40)
        const site = plan.findBuildSite(bot, 7, 24)
        if (!site) { console.log('   平らな場所が見つからない'); return false }
        console.log(`   建てる場所: ${site.x},${site.y},${site.z}`)
        await skills.goToPosition(bot, site.x + 3, site.y, site.z - 2, 2)
        const r = await plan.buildHut(bot, site.x + 3, site.y, site.z + 3)
        console.log(`   小屋: ${r.placed}/${r.total} ブロック`)
        return r.placed >= r.total * 0.6
      })
    }
  }
  console.log('RESULT ' + results.map(([l, ok, t]) => `${ok ? '○' : '×'}${l}(${t})`).join(' '))
  console.log('INVENTORY ' + bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', '))
  body.stop()
  bot.quit()
  setTimeout(() => process.exit(0), 500)
})
