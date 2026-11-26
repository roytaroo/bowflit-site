// 行動ツール。LLMは「どのツールを、どの引数で使うか」だけを決め、実際の操作はここ (通常のプログラム) が行う。
// どれも結果を日本語の短い文で返し、それが記憶とLLMへのフィードバックになる。
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { FOOD } from './perception.js'
import { sleep, withTimeout } from '../util/log.js'

const require = createRequire(import.meta.url)
const { goals } = require('mineflayer-pathfinder')

const BUILD_BLOCKS = ['cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'stone', 'stone_bricks', 'bricks', 'dirt', 'sandstone', 'deepslate', 'cobbled_deepslate']
const FLOWERS = ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley']

// ----- 共通ヘルパー -----
function mcData (bot) { return require('minecraft-data')(bot.version) }

// 経路探索で移動。直前の stop() が残っていて「Path was stopped」で即失敗することがあるので1回だけやり直す
export async function gotoGoal (bot, goal, timeoutMs, label = 'move') {
  for (let i = 0; ; i++) {
    try { return await withTimeout(bot.pathfinder.goto(goal), timeoutMs, label) } catch (e) {
      if (i === 0 && /stopped before|goal was changed/i.test(e.message)) { await sleep(200); continue }
      throw e
    }
  }
}

// 穴や囲まれた場所にはまって動けないとき: 経路探索は使わず (掘る経路探索はメモリを食い尽くす)、
// 直接操作で「目の前のブロックを掘る → ジャンプしながら前へ」を数回だけ試す
export async function unstick (bot, toward = null) {
  if (bot.__unsticking) return false
  bot.__unsticking = true
  const start = bot.entity.position.clone()
  try {
    try { bot.pathfinder.stop(); bot.pathfinder.setGoal(null) } catch {}
    const p = bot.entity.position
    let yaw
    if (toward) yaw = Math.atan2(-(toward.x - p.x), -(toward.z - p.z))
    else yaw = Math.random() * Math.PI * 2
    for (let attempt = 0; attempt < 3 && bot.entity.position.distanceTo(start) < 2; attempt++) {
      await bot.look(yaw + attempt * 1.2, 0, true).catch(() => {})
      const dir = new Vec3(-Math.sin(yaw + attempt * 1.2), 0, -Math.cos(yaw + attempt * 1.2))
      const front = bot.entity.position.plus(dir).floored()
      // 目の前の足元と顔の高さのブロックを掘る (固いブロックや危ない所は掘らない)
      for (const dy of [1, 0]) {
        const b = bot.blockAt(front.offset(0, dy, 0))
        if (b && b.boundingBox === 'block' && b.diggable && !/bedrock|obsidian|chest|bed|crafting_table|furnace/.test(b.name)) {
          const below = bot.blockAt(front.offset(0, -1, 0))
          if (below && /lava|water/.test(below.name)) continue
          await withTimeout(bot.dig(b), 6000, 'dig').catch(() => {})
        }
      }
      bot.setControlState('forward', true); bot.setControlState('jump', true)
      await sleep(1200)
      bot.clearControlStates()
    }
  } finally { bot.clearControlStates(); bot.__unsticking = false }
  return bot.entity.position.distanceTo(start) >= 2
}

export async function goNear (bot, pos, range = 2, timeoutMs = 60000) {
  // 遠いときは中継地点に分けて近づいてから、最後に正確な位置へ
  if (Math.hypot(pos.x - bot.entity.position.x, pos.z - bot.entity.position.z) > 28) {
    await travelXZ(bot, pos.x, pos.z, { timeoutMs, y: pos.y })
  }
  const g = new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), range)
  try {
    await gotoGoal(bot, g, timeoutMs)
  } catch (e) {
    bot.pathfinder.stop()
    // はまって動けないなら抜け出してからもう一度
    if (/No path|timeout|stopped/i.test(e.message) && await unstick(bot, pos)) {
      await gotoGoal(bot, g, Math.min(timeoutMs, 30000)).catch(() => {})
      if (bot.entity.position.distanceTo(pos) <= range + 2) return
    }
    throw e
  }
}

// 遠くへの移動は 24ブロックずつの中継地点に分けて進む (経路探索の範囲を小さく保ってメモリを抑える)
export async function travelXZ (bot, x, z, { step = 24, timeoutMs = 150000, interrupted = () => false, y = null } = {}) {
  const start = bot.entity.position.clone()
  const end = Date.now() + timeoutMs
  let fails = 0
  while (Date.now() < end && !interrupted()) {
    const p = bot.entity.position
    const dx = x - p.x; const dz = z - p.z
    const dist = Math.hypot(dx, dz)
    if (dist <= 3) break
    const k = Math.min(1, step / dist)
    // 失敗したら少し横にずらした中継地点を試す
    const side = fails ? (fails % 2 ? 1 : -1) * 6 * Math.ceil(fails / 2) : 0
    const tx = p.x + dx * k + (-dz / dist) * side
    const tz = p.z + dz * k + (dx / dist) * side
    const goal = (dist <= step && y != null) ? new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), 2) : new goals.GoalNearXZ(Math.floor(tx), Math.floor(tz), 2)
    const before = bot.entity.position.clone()
    try {
      await gotoGoal(bot, goal, 30000)
      fails = 0
    } catch (e) {
      try { bot.pathfinder.stop() } catch {}
      // ほとんど動けていない = はまっている → 掘る/積むのを許して抜け出す
      if (bot.entity.position.distanceTo(before) < 2) await unstick(bot, { x, z })
      if (++fails > 4) break
      await sleep(300)
    }
  }
  const moved = Math.round(bot.entity.position.distanceTo(start))
  const left = Math.round(Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z))
  return { moved, left, arrived: left <= 4 }
}

// ブロック探しは「ブロックIDの一覧」で渡す (関数で渡すと周りの全ブロックを1つずつ調べるので、とても重くて固まる)
const idCache = new Map()
export function blockIds (bot, pred, key = null) {
  const k = key && `${bot.version}|${key}`
  if (k && idCache.has(k)) return idCache.get(k)
  const ids = mcData(bot).blocksArray.filter(b => pred(b.name, b)).map(b => b.id)
  if (k) idCache.set(k, ids)
  return ids
}

// 今の持ち物で、このブロックを掘って手に入れられるか
export function canHarvest (bot, block) {
  const tools = block?.harvestTools
  if (!tools) return true
  return bot.inventory.items().some(i => tools[i.type])
}

function invCount (bot, pred) {
  return bot.inventory.items().filter(i => typeof pred === 'string' ? i.name === pred : pred(i.name)).reduce((n, i) => n + i.count, 0)
}

function findItem (bot, pred) {
  return bot.inventory.items().find(i => typeof pred === 'string' ? i.name === pred : pred(i.name))
}

function inProtectedZone (store, pos, exceptOwner = null) {
  const zones = store.all('SELECT * FROM protected_zones')
  return zones.some(z => z.owner !== exceptOwner && Math.abs(pos.x - z.x) <= z.radius && Math.abs(pos.z - z.z) <= z.radius && Math.abs(pos.y - z.y) <= z.radius)
}

// "log" や "木" のような曖昧な指定をブロック名の判定関数にする
export function blockMatcher (name) {
  const n = String(name || '').toLowerCase().trim()
  const alias = {
    木: 'log', 原木: 'log', wood: 'log', 石: 'stone', 丸石: 'stone', 土: 'dirt', 砂: 'sand', 石炭: 'coal_ore',
    鉄: 'iron_ore', 銅: 'copper_ore', 金: 'gold_ore', ダイヤ: 'diamond_ore', diamond: 'diamond_ore', iron: 'iron_ore',
    coal: 'coal_ore', 花: 'flower', 小麦: 'wheat'
  }
  const key = alias[n] || n
  if (key === 'log' || key.endsWith('_log') || key.endsWith('_wood')) return b => b.endsWith('_log') // oak_log が無くても他の木でよい
  if (key === 'stone') return b => b === 'stone' || b === 'cobblestone'
  if (key === 'flower') return b => FLOWERS.includes(b)
  if (key.endsWith('_ore')) return b => b === key || b === 'deepslate_' + key
  return b => b === key
}

async function placeBlockAt (bot, target, itemName) {
  const item = findItem(bot, itemName)
  if (!item) throw new Error(`${itemName}を持っていない`)
  const existing = bot.blockAt(target)
  if (existing && existing.name !== 'air' && existing.name !== 'cave_air' && !existing.name.includes('grass') && existing.name !== 'snow') return false
  const faces = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]
  for (const f of faces) {
    const ref = bot.blockAt(target.plus(f))
    if (ref && ref.boundingBox === 'block') {
      if (bot.entity.position.distanceTo(target) > 4.2) await goNear(bot, target, 3, 20000)
      // 自分が設置位置に立っていたら少しずれる
      const me = bot.entity.position.floored()
      if (me.x === target.x && me.z === target.z && (me.y === target.y || me.y + 1 === target.y)) {
        await goNear(bot, target.offset(2, 0, 2), 1, 8000).catch(() => {})
      }
      await bot.equip(item, 'hand')
      await bot.placeBlock(ref, f.scaled(-1))
      return true
    }
  }
  return false
}

function pickBuildBlock (bot, needed) {
  const counts = BUILD_BLOCKS.map(n => [n, invCount(bot, n)]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])
  const total = counts.reduce((s, [, c]) => s + c, 0)
  return { counts, total, enough: total >= needed }
}

function nextBuildItem (bot) {
  for (const n of BUILD_BLOCKS) if (invCount(bot, n) > 0) return n
  return null
}

async function placeMany (bot, positions, stopCheck) {
  let placed = 0; let failed = 0
  for (const p of positions) {
    if (stopCheck()) break
    const name = nextBuildItem(bot)
    if (!name) break
    try { if (await placeBlockAt(bot, p, name)) placed++ } catch { failed++ }
  }
  return { placed, failed }
}

// レシピの材料をLLM向けに説明 (例: "必要: oak_planks x2")
function missingCount (bot, r) {
  let miss = 0
  for (const d of r.delta || []) if (d.count < 0) miss += Math.max(0, -d.count - bot.inventory.items().filter(i => i.type === d.id).reduce((n, i) => n + i.count, 0))
  return miss
}

function bestRecipe (bot, itemId) {
  // 材料違いのレシピが複数ある (丸石/深層岩 など) ので、持っている材料に一番近いものを選ぶ
  const all = bot.recipesAll(itemId, null, true)
  return all.sort((a, b) => missingCount(bot, a) - missingCount(bot, b))[0] || null
}

function describeIngredients (bot, md, itemId) {
  const r = bestRecipe(bot, itemId)
  if (!r) return 'レシピ不明'
  const generic = n => n.endsWith('_planks') ? '板材(oak_planks等)' : n.endsWith('_log') ? '原木' : n
  const need = (r.delta || []).filter(d => d.count < 0).map(d => `${generic(md.items[d.id]?.name || String(d.id))} x${-d.count}`)
  return '必要: ' + need.join(', ')
}

// ----- 作業の下ごしらえ (原木→板材→棒・作業台 を自動で作る) -----
async function ensurePlanks (bot, md, n) {
  const planks = () => invCount(bot, x => x.endsWith('_planks'))
  for (let guard = 0; planks() < n && guard < 8; guard++) {
    const log = findItem(bot, x => x.endsWith('_log') || x.endsWith('_stem'))
    if (!log) break
    const plank = md.itemsByName[log.name.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks')]
    const r = plank && bot.recipesFor(plank.id, null, 1, null)[0]
    if (!r) break
    await bot.craft(r, 1, null)
    await sleep(150)
  }
  return planks() >= n
}

async function ensureSticks (bot, md, n) {
  for (let guard = 0; invCount(bot, 'stick') < n && guard < 4; guard++) {
    if (!await ensurePlanks(bot, md, 2)) break
    const r = bot.recipesFor(md.itemsByName.stick.id, null, 1, null)[0]
    if (!r) break
    await bot.craft(r, 1, null)
    await sleep(150)
  }
  return invCount(bot, 'stick') >= n
}

// 足元の周りで、物を置ける場所 (下が地面で、そこが空いている) を探す
function freeSpotsAround (bot, need2 = false) {
  const me = bot.entity.position.floored()
  const out = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
    for (const dy of [0, -1, 1]) {
      const p = me.offset(dx, dy, dz)
      const at = bot.blockAt(p); const below = bot.blockAt(p.offset(0, -1, 0)); const above = bot.blockAt(p.offset(0, 1, 0))
      const empty = b => b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'short_grass' || b.name === 'grass')
      if (empty(at) && below && below.boundingBox === 'block' && empty(above)) {
        if (need2) { // ベッドは2マス必要
          const p2 = p.offset(dx === 0 ? 0 : Math.sign(dx), 0, dz === 0 ? 0 : Math.sign(dz))
          const b2 = bot.blockAt(p2); const bb2 = bot.blockAt(p2.offset(0, -1, 0))
          if (!(empty(b2) && bb2 && bb2.boundingBox === 'block')) continue
        }
        out.push(p); break
      }
    }
  }
  return out
}

async function ensureTable (bot, md) {
  let table = bot.findBlock({ matching: md.blocksByName.crafting_table.id, maxDistance: 24 })
  if (table) return table
  if (!findItem(bot, 'crafting_table')) {
    if (!await ensurePlanks(bot, md, 4)) return null
    const r = bot.recipesFor(md.itemsByName.crafting_table.id, null, 1, null)[0]
    if (!r) return null
    await bot.craft(r, 1, null)
    await sleep(150)
  }
  for (const p of freeSpotsAround(bot)) {
    try { if (await placeBlockAt(bot, p, 'crafting_table')) break } catch {}
  }
  table = bot.findBlock({ matching: md.blocksByName.crafting_table.id, maxDistance: 8 })
  return table
}

// 5x5 の小屋 (壁3段・入口・屋根) の設計図
export function houseBlueprint (origin, size = 5) {
  const out = []
  const s = Math.max(5, Math.min(9, size))
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < s; x++) {
      for (let z = 0; z < s; z++) {
        const edge = x === 0 || z === 0 || x === s - 1 || z === s - 1
        if (!edge) continue
        const door = z === 0 && x === Math.floor(s / 2) && y < 2
        if (!door) out.push(origin.offset(x, y, z))
      }
    }
  }
  for (let x = 0; x < s; x++) for (let z = 0; z < s; z++) out.push(origin.offset(x, 3, z))
  return out
}

// LLMが引数の名前を間違えても読めるように、相手の名前を探す
function targetName (ctx, a) {
  const raw = a.name ?? a.player ?? a.target ?? a.to ?? a.who ?? a.with
  if (!raw) return null
  return ctx.agent.society.resolveName?.(String(raw)) || String(raw)
}

function playerEntity (bot, name) {
  return name ? bot.players[name]?.entity : null
}

// ----- 行動の定義 -----
// desc と args はそのままLLMへの説明に使う
export const ACTIONS = {
  go_to: {
    desc: '座標へ移動', args: '{"x":数,"y":数,"z":数}',
    async run (ctx, a) {
      const r = await travelXZ(ctx.bot, a.x, a.z, { timeoutMs: 120000, interrupted: ctx.interrupted })
      return r.arrived ? `(${a.x},${a.z})に着いた` : `(${a.x},${a.z})へ向かったが途中で止まった (${r.moved}m進んだ。残り${r.left}m)`
    }
  },
  go_home: {
    desc: '自分の家に帰る', args: '{}',
    async run (ctx) {
      if (!ctx.agent.home) return 'まだ家がない'
      const h = ctx.agent.home
      await goNear(ctx.bot, new Vec3(h.x, h.y, h.z), 2, 120000)
      return '家に帰ってきた'
    }
  },
  go_to_player: {
    desc: '仲間や人間のところへ行く', args: '{"name":"名前"}',
    async run (ctx, a) {
      // 名前が無いときは、話しかけてきた人間 (いなければプレイヤー) のところへ
      const name = targetName(ctx, a) || ctx.agent.lastHumanSpeaker || ctx.agent.cfg?.player?.name
      if (!name) return '誰のところへ行くか指定されていない (name に名前を入れること)'
      const p = playerEntity(ctx.bot, name)
      if (!p) return `${name}の居場所が分からない (遠くにいるか、ワールドにいない)`
      await goNear(ctx.bot, p.position, 2, 60000)
      return `${name}のそばに来た`
    }
  },
  follow: {
    desc: '誰かについて行く(秒数)', args: '{"name":"名前","seconds":数}',
    async run (ctx, a) {
      const name = targetName(ctx, a)
      const p = playerEntity(ctx.bot, name)
      if (!p) return `${name || '相手'}が見当たらない`
      ctx.bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true)
      const sec = Math.min(120, Number(a.seconds) || 30)
      for (let i = 0; i < sec && !ctx.interrupted(); i++) await sleep(1000)
      ctx.bot.pathfinder.setGoal(null)
      return `${name}について行った`
    }
  },
  explore: {
    desc: '方角へ探索に出る', args: '{"direction":"north|south|east|west","distance":数}',
    async run (ctx, a) {
      const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], 北: [0, -1], 南: [0, 1], 東: [1, 0], 西: [-1, 0] }
      const d = dirs[a.direction] || Object.values(dirs)[Math.floor(Math.random() * 4)]
      const dist = Number(a.distance) || 48
      const p = ctx.bot.entity.position
      const r = await travelXZ(ctx.bot, p.x + d[0] * dist, p.z + d[1] * dist, { interrupted: ctx.interrupted })
      if (!r.arrived) return `探索を途中でやめた (${r.moved}m進んだ。地形が険しくて進めない)`
      ctx.agent.society.recordDiscovery?.(ctx.agent.name, ctx.bot.entity.position)
      return `${a.direction}へ${dist}m探索した`
    }
  },
  wander: {
    desc: '近所を散歩する', args: '{"radius":数}',
    async run (ctx, a) {
      const r = Math.min(24, Number(a.radius) || 12)
      const p = ctx.bot.entity.position
      const t = p.offset((Math.random() * 2 - 1) * r, 0, (Math.random() * 2 - 1) * r)
      await gotoGoal(ctx.bot, new goals.GoalXZ(Math.floor(t.x), Math.floor(t.z)), 40000, 'wander').catch(() => ctx.bot.pathfinder.stop())
      return '近くを散歩した'
    }
  },
  collect: {
    desc: 'ブロックを掘って集める', args: '{"block":"oak_log|log|stone|coal_ore|iron_ore|dirt|sand|flower 等","count":数}',
    async run (ctx, a) {
      const { bot } = ctx
      const match = blockMatcher(a.block)
      const want = Number(a.count) || 4
      // 地中に埋まったブロックを目指すと経路探索が膨らむので、空気に面した(見えている)ブロックを優先
      // 空気に面した(見えている)ブロックだけ。水の中・水に面したブロックは泳ぐことになり失敗しやすいので避ける
      const isAir = n => n && (n.name === 'air' || n.name === 'cave_air')
      const exposed = p => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => isAir(bot.blockAt(p.offset(x, y, z))))
      const wet = p => [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => { const n = bot.blockAt(p.offset(x, y, z)); return n && n.name === 'water' })
      const find = () => {
        const me = bot.entity.position
        const all = bot.findBlocks({ matching: blockIds(bot, n => match(n), 'collect:' + a.block), maxDistance: 32, count: Math.min(300, want * 10) })
          .filter(p => !inProtectedZone(ctx.store, p, ctx.agent.name) && !wet(p))
        let t = all.filter(exposed).sort((a, b) => a.distanceTo(me) - b.distanceTo(me)).slice(0, want * 2)
        // 見えているブロックが無ければ、地面のすぐ下 (上から掘れる浅い所) を少しだけ狙う
        if (!t.length) t = all.filter(p => p.y >= me.y - 4 && p.y <= me.y).sort((a, b) => a.distanceTo(me) - b.distanceTo(me)).slice(0, Math.min(4, want))
        return t
      }
      const before = bot.inventory.items().reduce((n, i) => n + i.count, 0)
      let got = 0; let lastErr = ''; let searched = 0
      let positions = find()
      // 近くに無ければ、自分で少し歩いて探す (LLMに戻らずに粘る)
      while (!positions.length && searched < 2 && !ctx.interrupted()) {
        searched++
        const ang = Math.random() * Math.PI * 2
        const p = bot.entity.position
        await travelXZ(bot, p.x + Math.cos(ang) * 28, p.z + Math.sin(ang) * 28, { timeoutMs: 30000, interrupted: ctx.interrupted })
        positions = find()
      }
      if (!positions.length) return `近くに${a.block}が見つからない (${searched ? '周りも探したけど無い。別の場所へ explore すること' : ''})`
      let failsInRow = 0
      // 掘りながら進む経路探索は重いので、探す範囲と時間を絞る (メモリあふれ対策)
      const pf = bot.pathfinder; const keep = { r: pf.searchRadius, t: pf.thinkTimeout }
      pf.searchRadius = 20; pf.thinkTimeout = 1500
      try {
      for (const p of positions) {
        if (got >= want || ctx.interrupted() || failsInRow >= 3) break
        const block = bot.blockAt(p)
        if (!block || !match(block.name)) continue
        // 道具が無いと掘れないブロック (石・鉱石) は、道具が無ければ掘りに行かない。
        // (採掘プラグインが道具を探して無限ループになり、固まってメモリがあふれるため)
        if (!canHarvest(bot, block)) { lastErr = 'ツルハシが無い (wooden_pickaxe か stone_pickaxe を craft すること)'; break }
        try {
          await withTimeout(bot.collectBlock.collect(block, { ignoreNoPath: true }), 15000, 'collect')
          const after = bot.blockAt(p)
          if (!after || !match(after.name)) { got++; failsInRow = 0 } else { lastErr = 'たどり着けなかった'; failsInRow++ }
        } catch (e) {
          failsInRow++
          lastErr = /No path/i.test(e.message) ? 'たどり着けなかった' : e.message.slice(0, 50)
          if (/timeout/.test(e.message)) { bot.pathfinder.stop(); lastErr = '時間切れ' }
        }
      }
      } finally { pf.searchRadius = keep.r; pf.thinkTimeout = keep.t }
      // 1個も掘れず、ほとんど動けていないなら、はまっている可能性 → 抜け出しておく
      if (got === 0 && failsInRow >= 2) await unstick(bot).catch(() => {})
      const after = bot.inventory.items().reduce((n, i) => n + i.count, 0)
      if (got === 0) return `${a.block}を掘れなかった (${lastErr || '理由不明'})`
      return `${a.block}を${got}個掘った (持ち物+${after - before})`
    }
  },
  craft: {
    desc: 'アイテムを作る(板材・棒・作業台は持っている原木から自動で用意。石は作れない→collect)', args: '{"item":"oak_planks|stick|crafting_table|wooden_pickaxe|stone_sword|torch|chest|bread 等","count":数}',
    async run (ctx, a) {
      const { bot } = ctx
      const md = mcData(bot)
      if (['stone', 'cobblestone', 'dirt', 'sand', 'gravel'].includes(a.item) || /_ore$|_log$/.test(a.item)) return `${a.item}は作れない。collect で掘って集めること`
      const item = md.itemsByName[a.item]
      if (!item) return `${a.item}というアイテムは知らない`
      const count = Math.max(1, Math.min(64, Number(a.count) || 1))
      // 持っているものを確認: すでに持っている道具を作ろうとしたら教える
      if (/_(pickaxe|sword|axe|shovel|hoe)$/.test(a.item) && findItem(bot, a.item)) return `${a.item}はもう持っている`
      // 板材・棒が足りなければ、持っている原木から自動で作る
      const best = bestRecipe(bot, item.id)
      for (const d of best?.delta || []) {
        if (d.count >= 0) continue
        const nm = md.items[d.id]?.name || ''
        if (nm.endsWith('_planks')) await ensurePlanks(bot, md, -d.count * Math.ceil(count / (best.result?.count || 1))).catch(() => {})
        if (nm === 'stick') await ensureSticks(bot, md, -d.count).catch(() => {})
      }
      let table = bot.findBlock({ matching: md.blocksByName.crafting_table.id, maxDistance: 24 })
      let recipe = bot.recipesFor(item.id, null, 1, null)[0]
      const needsTable = bot.recipesAll(item.id, null, null).length === 0
      if (!recipe && !needsTable) return `${a.item}の材料が足りない (${describeIngredients(bot, md, item.id)})`
      if (!recipe) {
        if (!table) table = await ensureTable(bot, md).catch(() => null)
        if (!table) return `${a.item}には作業台が必要だが作れなかった (板材4つ=原木1つ が要る。${describeIngredients(bot, md, item.id)})`
        await goNear(bot, table.position, 2, 30000)
        recipe = bot.recipesFor(item.id, null, 1, table)[0]
      }
      if (!recipe) return `${a.item}の材料が足りない (${describeIngredients(bot, md, item.id)})`
      const perCraft = recipe.result?.count || 1
      const times = Math.ceil(count / perCraft)
      let done = 0
      for (let i = 0; i < times; i++) {
        let ok = false
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          const r = bot.recipesFor(item.id, null, 1, table)[0]
          if (!r) break
          try { await bot.craft(r, 1, table || undefined); ok = true } catch (e) {
            // 直前に作った材料が持ち物にまだ反映されていないことがあるので、少し待ってやり直す
            if (attempt === 1) { if (!done) throw e } else await sleep(500)
          }
        }
        if (!ok) break
        done += perCraft
      }
      return done ? `${a.item}を${done}個作った` : `${a.item}の材料が足りない`
    }
  },
  eat: {
    desc: '食事する', args: '{}',
    async run (ctx) {
      const { bot } = ctx
      const order = [...FOOD].filter(f => !['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato'].includes(f))
      const food = bot.inventory.items().find(i => order.includes(i.name)) || bot.inventory.items().find(i => FOOD.has(i.name))
      if (!food) return '食べ物を持っていない'
      if (bot.food >= 20) return 'お腹がいっぱい'
      await bot.equip(food, 'hand')
      await withTimeout(bot.consume(), 10000, 'eat')
      return `${food.name}を食べた`
    }
  },
  sleep: {
    desc: '夜にベッドで寝る', args: '{}',
    async run (ctx) {
      const { bot } = ctx
      let bed = bot.findBlock({ matching: blockIds(bot, n => n.endsWith('_bed'), 'bed'), maxDistance: 48 })
      // 前に置いた自分のベッドが遠くにあるなら、そこへ戻る
      const mine = ctx.agent.bedPos
      if (!bed && mine && bot.entity.position.distanceTo(new Vec3(mine.x, mine.y, mine.z)) < 120) {
        await goNear(bot, new Vec3(mine.x, mine.y, mine.z), 3, 60000).catch(() => {})
        bot.waitForChunksToLoad && await bot.waitForChunksToLoad().catch(() => {})
        bed = bot.findBlock({ matching: blockIds(bot, n => n.endsWith('_bed'), 'bed'), maxDistance: 8 })
      }
      // ベッドを持っていれば、その場に置いて寝る
      const bedItem = findItem(bot, n => n.endsWith('_bed'))
      if (!bed && bedItem) {
        for (const p of freeSpotsAround(bot, true)) {
          try { if (await placeBlockAt(bot, p, bedItem.name)) break } catch {}
        }
        bed = bot.findBlock({ matching: blockIds(bot, n => n.endsWith('_bed'), 'bed'), maxDistance: 6 })
        if (bed) {
          ctx.agent.bedPos = { x: bed.position.x, y: bed.position.y, z: bed.position.z }
          ctx.store?.setState?.(`bed:${ctx.agent.name}`, ctx.agent.bedPos)
          ctx.agent.memory?.add?.('event', `(${bed.position.x},${bed.position.z})にベッドを置いた`, { importance: 4 })
        }
      }
      if (!bed) return '近くにベッドがない (wool3個+木材3個でwhite_bedを作れる)'
      await goNear(bot, bed.position, 2, 60000)
      try { await bot.sleep(bed) } catch (e) {
        // 誰かが使っているベッドだったら、自分のベッドを隣に置いて寝る
        const own = /occupied/i.test(e.message) && findItem(bot, n => n.endsWith('_bed'))
        if (!own) return `眠れなかった: ${/occupied/i.test(e.message) ? 'ベッドが使われていた' : e.message}`
        for (const p of freeSpotsAround(bot, true)) { try { if (await placeBlockAt(bot, p, own.name)) break } catch {} }
        const mine = bot.findBlock({ matching: blockIds(bot, n => n.endsWith('_bed'), 'bed'), maxDistance: 5, useExtraInfo: b => !b.getProperties?.().occupied })
        if (!mine) return '眠れなかった: ベッドが使われていた'
        ctx.agent.bedPos = { x: mine.position.x, y: mine.position.y, z: mine.position.z }
        ctx.store?.setState?.(`bed:${ctx.agent.name}`, ctx.agent.bedPos)
        try { await bot.sleep(mine) } catch (e2) { return `眠れなかった: ${e2.message}` }
      }
      while (bot.isSleeping && !ctx.interrupted()) await sleep(1000)
      return 'ぐっすり眠った'
    }
  },
  attack: {
    desc: '近くの敵や動物を倒す', args: '{"target":"zombie|skeleton|cow|pig 等"}',
    async run (ctx, a) {
      const { bot } = ctx
      const e = bot.nearestEntity(en => en.name === a.target && en.position.distanceTo(bot.entity.position) < 24)
      if (!e) return `近くに${a.target}がいない`
      const weapon = bot.inventory.items().filter(i => /_(sword|axe)$/.test(i.name)).sort((x, y) => (y.attackDamage || 0) - (x.attackDamage || 0))[0]
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      bot.pvp.attack(e)
      const start = Date.now()
      while (e.isValid && Date.now() - start < 25000 && !ctx.interrupted()) await sleep(500)
      bot.pvp.stop()
      return e.isValid ? `${a.target}を倒しきれなかった` : `${a.target}を倒した`
    }
  },
  flee: {
    desc: '危険から逃げる', args: '{"from":"敵の名前"}',
    async run (ctx, a) {
      const { bot } = ctx
      bot.pvp?.stop()
      const enemy = bot.nearestEntity(en => en.name === a.from)
      const me = bot.entity.position
      let target
      if (ctx.agent.home && Math.hypot(me.x - ctx.agent.home.x, me.z - ctx.agent.home.z) < 80) target = new Vec3(ctx.agent.home.x, ctx.agent.home.y, ctx.agent.home.z)
      else if (enemy) target = me.plus(me.minus(enemy.position).normalize().scaled(20))
      else target = me.offset(16, 0, 0)
      await travelXZ(bot, target.x, target.z, { timeoutMs: 20000 })
      return `${a.from || '危険'}から逃げた`
    }
  },
  escape_hazard: {
    desc: '溶岩や火から離れる', args: '{}',
    async run (ctx) {
      const { bot } = ctx
      if (bot.entity.isInWater) {
        // 溺れそう: 経路探索は水中だと失敗しやすいので、直接操作で泳ぐ
        try { bot.pathfinder.stop(); bot.pathfinder.setGoal(null) } catch {}
        const headWet = () => { const b = bot.blockAt(bot.entity.position.offset(0, 1.6, 0)); return b && b.name === 'water' }
        bot.clearControlStates()
        bot.setControlState('jump', true) // 1) まず真上へ泳いで息をする
        for (let t = 0; t < 25 && headWet(); t++) await sleep(200)
        // 2) いちばん近い陸 (上が空気2マスある固いブロック) へまっすぐ泳ぐ
        const land = bot.findBlock({
          maxDistance: 32,
          matching: blockIds(bot, (n, b) => b.boundingBox === 'block' && n !== 'water' && !n.includes('leaves'), 'land'),
          useExtraInfo: blk => {
            const u1 = bot.blockAt(blk.position.offset(0, 1, 0)); const u2 = bot.blockAt(blk.position.offset(0, 2, 0))
            return u1 && u1.name === 'air' && u2 && u2.name === 'air' && blk.position.y >= Math.floor(bot.entity.position.y) - 2
          }
        })
        if (land) {
          const target = land.position.offset(0.5, 1.6, 0.5)
          bot.setControlState('forward', true); bot.setControlState('sprint', true)
          for (let t = 0; t < 60 && bot.entity.isInWater && !ctx.interrupted(); t++) {
            await bot.lookAt(target, true).catch(() => {})
            await sleep(200)
          }
        } else {
          for (let t = 0; t < 15 && bot.entity.isInWater; t++) await sleep(200)
        }
        bot.clearControlStates()
        if (!bot.entity.isInWater) return '水から上がった'
        return land ? 'まだ水の中 (陸へ向かって泳いでいる)' : 'まだ水の中 (近くに陸が見えない)'
      }
      const water = bot.findBlock({ matching: blockIds(bot, n => n === 'water', 'water'), maxDistance: 12 })
      bot.setControlState('jump', true)
      if (water) await goNear(bot, water.position, 0, 6000).catch(() => {})
      else await withTimeout(bot.pathfinder.goto(new goals.GoalXZ(Math.floor(bot.entity.position.x + 6), Math.floor(bot.entity.position.z))), 6000, 'escape').catch(() => bot.pathfinder.stop())
      bot.setControlState('jump', false)
      return '危険な場所から離れた'
    }
  },
  give: {
    desc: '相手にアイテムを渡す(プレゼント)', args: '{"to":"名前","item":"アイテム名","count":数}',
    async run (ctx, a) {
      const { bot } = ctx
      const it = findItem(bot, a.item)
      if (!it) return `${a.item}を持っていない`
      a.to = ctx.agent.society.resolveName?.(String(a.to ?? a.name ?? a.player ?? '')) || a.to
      const p = bot.players[a.to]?.entity
      if (!p) return `${a.to}が近くにいない`
      await goNear(bot, p.position, 2, 60000)
      await bot.lookAt(p.position.offset(0, 1.6, 0))
      const n = Math.min(it.count, Number(a.count) || 1)
      await bot.toss(it.type, null, n)
      ctx.agent.onGave?.(a.to, a.item, n)
      return `${a.to}に${a.item}を${n}個渡した`
    }
  },
  store_items: {
    desc: '家のチェストに荷物を整理してしまう', args: '{}',
    async run (ctx) {
      const { bot } = ctx
      const chest = bot.findBlock({ matching: blockIds(bot, n => n === 'chest', 'chest'), maxDistance: 32 })
      if (!chest) return '近くにチェストがない (chestを作って家に置くと良い)'
      await goNear(bot, chest.position, 2, 40000)
      const c = await bot.openContainer(chest)
      let n = 0
      try {
        for (const it of bot.inventory.items()) {
          if (/_(sword|pickaxe|axe|shovel|hoe)$|fishing_rod/.test(it.name) || FOOD.has(it.name) || BUILD_BLOCKS.includes(it.name)) continue
          await c.deposit(it.type, null, it.count).then(() => { n += it.count }).catch(() => {})
        }
      } finally { c.close() }
      return n ? `チェストに${n}個しまった` : 'しまう物がなかった'
    }
  },
  build_house: {
    desc: '家(小屋)を建てる。建材約70個必要。場所は家の位置か現在地', args: '{"size":5}',
    async run (ctx, a) {
      const { bot } = ctx
      const size = Math.max(5, Math.min(7, Number(a.size) || 5))
      const plan = houseBlueprint(new Vec3(0, 0, 0), size).length
      const mat = pickBuildBlock(bot, plan)
      if (mat.total < 20) return `建材が足りない (${mat.total}個/約${plan}個必要。cobblestoneや板材を集めること)`
      const base = ctx.agent.home ? new Vec3(ctx.agent.home.x, ctx.agent.home.y, ctx.agent.home.z) : bot.entity.position.floored()
      const origin = base.offset(-Math.floor(size / 2), 0, -Math.floor(size / 2))
      if (!ctx.agent.home) ctx.agent.setHome({ x: base.x, y: base.y, z: base.z })
      const blueprint = houseBlueprint(origin, size)
      const r = await placeMany(bot, blueprint, ctx.interrupted)
      const progress = ctx.agent.addBuildProgress('house', r.placed, blueprint.length)
      if (progress >= 1) {
        ctx.agent.society.shared.add('build', `${ctx.agent.name}の家が完成した`, { importance: 6, participants: [ctx.agent.name], day: ctx.agent.day() })
        return `家が完成した! (${r.placed}ブロック設置)`
      }
      return `家を建築中: ${r.placed}ブロック設置 (進捗${Math.round(progress * 100)}%)。${mat.enough ? '' : '建材が足りないので集める必要あり'}`
    }
  },
  set_home: {
    desc: '今いる場所を自分の家(拠点)にする', args: '{}',
    async run (ctx) {
      const p = ctx.bot.entity.position.floored()
      ctx.agent.setHome({ x: p.x, y: p.y, z: p.z })
      return `ここ(${p.x},${p.z})を自分の家にした`
    }
  },
  plant_and_harvest: {
    desc: '畑の実った小麦を収穫して種を植え直す', args: '{}',
    async run (ctx) {
      const { bot } = ctx
      const ripe = bot.findBlocks({ matching: blockIds(bot, n => n === 'wheat', 'wheat'), maxDistance: 24, count: 64 })
        .filter(p => bot.blockAt(p)?.getProperties?.().age === 7).slice(0, 16)
      let h = 0; let p = 0
      for (const pos of ripe) {
        if (ctx.interrupted()) break
        const b = bot.blockAt(pos)
        await goNear(bot, pos, 2, 15000).catch(() => {})
        await bot.dig(b).then(() => h++).catch(() => {})
      }
      const farmland = bot.findBlocks({ matching: blockIds(bot, n => n === 'farmland', 'farmland'), maxDistance: 24, count: 32 })
      for (const pos of farmland) {
        if (ctx.interrupted() || !findItem(bot, 'wheat_seeds')) break
        const above = bot.blockAt(pos.offset(0, 1, 0))
        if (!above || above.name !== 'air') continue
        await goNear(bot, pos, 2, 15000).catch(() => {})
        await bot.equip(findItem(bot, 'wheat_seeds'), 'hand').catch(() => {})
        await bot.placeBlock(bot.blockAt(pos), new Vec3(0, 1, 0)).then(() => p++).catch(() => {})
      }
      if (!ripe.length && !farmland.length) return '近くに畑がない (hoeで土を耕して種を植えると畑になる)'
      return `小麦を${h}回収穫し、種を${p}個植えた`
    }
  },
  fish: {
    desc: '釣りをする(釣り竿と近くの水が必要)', args: '{"times":数}',
    async run (ctx, a) {
      const { bot } = ctx
      const rod = findItem(bot, 'fishing_rod')
      if (!rod) return '釣り竿を持っていない (stick3+string2で作れる)'
      const water = bot.findBlock({ matching: blockIds(bot, n => n === 'water', 'water'), maxDistance: 32 })
      if (!water) return '近くに水がない'
      await goNear(bot, water.position, 3, 30000)
      await bot.equip(rod, 'hand')
      await bot.lookAt(water.position.offset(0.5, 0.5, 0.5))
      let caught = 0
      const times = Math.min(5, Number(a.times) || 3)
      for (let i = 0; i < times && !ctx.interrupted(); i++) {
        try { await withTimeout(bot.fish(), 45000, 'fish'); caught++ } catch { bot.activateItem() }
      }
      return caught ? `${caught}回釣れた` : '何も釣れなかった'
    }
  },
  build_grave: {
    desc: '亡くなった仲間のお墓を建てる', args: '{"for":"故人の名前","epitaph":"墓碑の言葉"}',
    async run (ctx, a) {
      const { bot } = ctx
      const name = a.for
      const death = ctx.store.get('SELECT * FROM deaths WHERE agent = ? ORDER BY id DESC LIMIT 1', name)
      if (!death) return `${name}が亡くなった記録はない`
      if (ctx.store.get('SELECT id FROM graves WHERE for_agent = ? AND death_id = ?', name, death.id)) return `${name}のお墓はもうある`
      const blockName = nextBuildItem(bot)
      if (!blockName) return 'お墓に使うブロックがない (cobblestoneなどを集めること)'
      // 墓地: 最初のお墓の場所 or 村の中心 or 自分の家の近く
      let yard = ctx.store.getState('graveyard')
      if (!yard) {
        const c = ctx.store.getState('village_center') || ctx.agent.home || bot.entity.position.floored()
        yard = { x: c.x + 8, y: c.y, z: c.z + 8 }
        ctx.store.setState('graveyard', yard)
      }
      const n = ctx.store.get('SELECT COUNT(*) AS n FROM graves').n
      const spot = new Vec3(yard.x + (n % 5) * 2, yard.y, yard.z + Math.floor(n / 5) * 3)
      await goNear(bot, spot, 3, 60000).catch(() => {})
      // 地面の高さに合わせる
      let ground = spot.clone()
      for (let dy = 3; dy > -4; dy--) {
        const b = bot.blockAt(spot.offset(0, dy, 0)); const below = bot.blockAt(spot.offset(0, dy - 1, 0))
        if (b && b.name === 'air' && below && below.boundingBox === 'block') { ground = spot.offset(0, dy, 0); break }
      }
      const ok = await placeBlockAt(bot, ground, blockName).catch(() => false)
      let signed = false
      const sign = findItem(bot, n2 => n2.endsWith('_sign') && !n2.includes('hanging'))
      const epitaph = String(a.epitaph || `${name} ここに眠る`).slice(0, 60)
      if (ok && sign) {
        try {
          await placeBlockAt(bot, ground.offset(0, 1, 0), sign.name)
          const sb = bot.blockAt(ground.offset(0, 1, 0))
          if (sb && sb.name.includes('sign')) { await bot.updateSign(sb, epitaph.match(/.{1,15}/g).slice(0, 4).join('\n')); signed = true }
        } catch {}
      }
      let flowers = 0
      for (const f of FLOWERS) {
        if (findItem(bot, f) && flowers < 2) {
          if (await placeBlockAt(bot, ground.offset(flowers ? -1 : 1, 0, 0), f).catch(() => false)) flowers++
        }
      }
      if (!ok) return 'お墓を建てる場所が見つからなかった'
      ctx.store.run('INSERT INTO graves (for_agent, death_id, x, y, z, epitaph, built_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        name, death.id, ground.x, ground.y, ground.z, epitaph, ctx.agent.name, Date.now())
      ctx.store.run('INSERT INTO protected_zones (owner, kind, x, y, z, radius) VALUES (?, ?, ?, ?, ?, ?)', 'grave:' + name, 'grave', ground.x, ground.y, ground.z, 2)
      ctx.store.run("UPDATE projects SET status = 'done', updated_at = ? WHERE kind = 'grave' AND target = ? AND status != 'done'", Date.now(), JSON.stringify({ for: name }))
      ctx.agent.society.shared.add('grave', `${ctx.agent.name}が${name}のお墓を建てた。墓碑「${epitaph}」`, { importance: 8, participants: [ctx.agent.name, name], day: ctx.agent.day() })
      return `${name}のお墓を建てた${signed ? `(墓碑「${epitaph}」)` : '(看板がないので墓碑は無し)'}${flowers ? `。花を${flowers}本供えた` : ''}`
    }
  },
  visit_grave: {
    desc: 'お墓参りをする', args: '{"for":"故人の名前"}',
    async run (ctx, a) {
      const g = ctx.store.get('SELECT * FROM graves WHERE for_agent = ? ORDER BY id DESC LIMIT 1', a.for)
      if (!g) return `${a.for}のお墓はまだない`
      await goNear(ctx.bot, new Vec3(g.x, g.y, g.z), 2, 90000)
      await sleep(5000)
      return `${a.for}のお墓参りをした`
    }
  },
  propose_project: {
    desc: '皆でやる計画を提案する(会議の議題になる)', args: '{"kind":"house|wall|road|expedition|festival|grave|other","title":"短い題名","detail":"内容"}',
    async run (ctx, a) {
      const id = ctx.agent.society.proposeProject(ctx.agent.name, a.kind || 'other', a.title || '無題', a.detail || '')
      return `計画「${a.title}」(#${id})を提案した`
    }
  },
  join_project: {
    desc: '提案された計画に参加する', args: '{"id":数}',
    async run (ctx, a) {
      return ctx.agent.society.joinProject(ctx.agent.name, Number(a.id))
    }
  },
  rest: {
    desc: '少し休む・考え事をする・景色を眺める', args: '{"seconds":数}',
    async run (ctx, a) {
      const sec = Math.min(60, Number(a.seconds) || 10)
      for (let i = 0; i < sec && !ctx.interrupted(); i++) {
        if (i % 4 === 0) await ctx.bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6).catch(() => {})
        await sleep(1000)
      }
      return '少し休んだ'
    }
  }
}

export function actionListForPrompt (allowed = null) {
  return Object.entries(ACTIONS)
    .filter(([k]) => !allowed || allowed.includes(k))
    .map(([k, v]) => `- ${k} ${v.args}: ${v.desc}`).join('\n')
}
