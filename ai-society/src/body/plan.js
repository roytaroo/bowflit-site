// 「○○を手に入れる」を、必要な下ごしらえ込みで自動でやる (LLMに頼らない)。
// 例: 石のツルハシ → (無ければ) 原木を集める → 板材 → 棒 → 作業台 → 木のツルハシ → 石を掘る → 石のツルハシ
import * as skills from './skills.js'
import * as world from './world.js'
import * as mc from './mcdata.js'

const LOG_TYPES = mc.WOOD_TYPES.map(w => w + '_log').concat(['crimson_stem', 'warped_stem'])

export function count (bot, name) {
  if (name === 'planks_same') return maxSamePlanks(bot)
  const inv = world.getInventoryCounts(bot)
  if (name === 'planks') return Object.entries(inv).filter(([k]) => k.endsWith('_planks')).reduce((n, [, v]) => n + v, 0)
  if (name === 'log') return Object.entries(inv).filter(([k]) => k.endsWith('_log') || k.endsWith('_stem')).reduce((n, [, v]) => n + v, 0)
  if (name === 'cobblestone') return (inv.cobblestone || 0) + (inv.cobbled_deepslate || 0)
  return inv[name] || 0
}

function hasPickaxe (bot, tier = 'wooden') {
  const order = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']
  const min = order.indexOf(tier)
  return bot.inventory.items().some(i => i.name.endsWith('_pickaxe') && order.indexOf(i.name.split('_')[0]) >= Math.min(min, order.indexOf('iron')))
}

// 近くにある原木の種類 (無ければ null)
function nearestLogType (bot, range = 64) {
  const b = world.getNearestBlocks(bot, LOG_TYPES, range, 1)[0]
  return b ? b.name : null
}

// 持っている原木の種類 (一番多いもの)
function ownedLogType (bot) {
  const inv = world.getInventoryCounts(bot)
  return Object.entries(inv).filter(([k]) => LOG_TYPES.includes(k)).sort((a, b) => b[1] - a[1])[0]?.[0] || null
}

// 原木を n 本以上持つ
async function getLogs (bot, n) {
  let guard = 0
  while (count(bot, 'log') < n && !bot.interrupt_code && guard++ < 6) {
    const type = nearestLogType(bot)
    if (!type) {
      skills.log(bot, '近くに木が無い。探しに出る。')
      await explore(bot, 48)
      continue
    }
    const need = n - count(bot, 'log')
    const before = count(bot, 'log')
    await skills.collectBlock(bot, type, Math.min(need, 8))
    // 1本も取れなかった (高すぎる木など) なら、別の場所の木を探しに行く
    if (count(bot, 'log') === before && !bot.interrupt_code) { skills.log(bot, `${type}に届かない。別の木を探す。`); await explore(bot, 32) }
  }
  return count(bot, 'log') >= n
}

// 板材を n 枚以上持つ (原木から作る)
async function getPlanks (bot, n) {
  if (count(bot, 'planks') >= n) return true
  const logsNeeded = Math.ceil((n - count(bot, 'planks')) / 4)
  if (count(bot, 'log') < logsNeeded && !await getLogs(bot, logsNeeded)) return false
  const log = ownedLogType(bot)
  if (!log) return false
  const plank = log.replace(/_(log|stem)$/, '_planks')
  await skills.craftRecipe(bot, plank, Math.ceil((n - count(bot, 'planks')) / 4))
  return count(bot, 'planks') >= n
}

// 板材を「同じ種類で」n 枚以上持つ。レシピは同じ種類の板材しか使えない
// (オークとトウヒが混ざっていると、3枚あっても木のツルハシが作れない)
function woodOf (name) { return name.replace(/^stripped_/, '').replace(/_(log|stem|planks|wood|hyphae)$/, '') }
function sameTypePlanks (bot) {
  const by = {}
  for (const i of bot.inventory.items()) if (i.name.endsWith('_planks')) by[woodOf(i.name)] = (by[woodOf(i.name)] || 0) + i.count
  return by
}
export function maxSamePlanks (bot) { return Math.max(0, ...Object.values(sameTypePlanks(bot))) }

async function getSamePlanks (bot, n) {
  for (let guard = 0; guard < 4 && maxSamePlanks(bot) < n && !bot.interrupt_code; guard++) {
    const planks = sameTypePlanks(bot)
    const logs = {}
    for (const i of bot.inventory.items()) if (LOG_TYPES.includes(i.name)) logs[woodOf(i.name)] = (logs[woodOf(i.name)] || 0) + i.count
    // 板材+原木で n 枚に届く種類を選ぶ。無ければ原木を集めてからもう一度
    const types = [...new Set([...Object.keys(planks), ...Object.keys(logs)])]
    const best = types.map(t => ({ t, total: (planks[t] || 0) + (logs[t] || 0) * 4 })).sort((a, b) => b.total - a.total)[0]
    if (!best || best.total < n) {
      if (!await getLogs(bot, count(bot, 'log') + Math.ceil((n - (best?.total || 0)) / 4))) return false
      continue
    }
    const plank = best.t + '_planks'
    await skills.craftRecipe(bot, plank, Math.ceil((n - (planks[best.t] || 0)) / 4))
  }
  return maxSamePlanks(bot) >= n
}

// 丸石を n 個以上持つ (石を掘る。ツルハシが無ければ作る)
async function getCobblestone (bot, n) {
  if (count(bot, 'cobblestone') >= n) return true
  if (!hasPickaxe(bot) && !await obtain(bot, 'wooden_pickaxe', 1)) return false
  let guard = 0
  while (count(bot, 'cobblestone') < n && !bot.interrupt_code && guard++ < 6) {
    const stone = world.getNearestBlocks(bot, ['stone', 'cobblestone', 'andesite', 'diorite', 'granite'], 32, 1)[0]
    if (!stone) {
      skills.log(bot, '近くに石が見えない。少し掘り下げる。')
      await skills.digDown(bot, 4)
      continue
    }
    if (!hasPickaxe(bot) && !await obtain(bot, 'wooden_pickaxe', 1)) return false
    await skills.collectBlock(bot, 'stone', Math.min(n - count(bot, 'cobblestone'), 8))
  }
  return count(bot, 'cobblestone') >= n
}

async function explore (bot, dist) {
  const p = bot.entity.position
  const a = Math.random() * Math.PI * 2
  await skills.goToPosition(bot, Math.round(p.x + Math.cos(a) * dist), p.y, Math.round(p.z + Math.sin(a) * dist), 3)
}

// 作業台が必要なレシピか
function needsTable (bot, item) {
  const id = mc.getItemId(item)
  return bot.recipesAll(id, null, null).length === 0 && bot.recipesAll(id, null, true).length > 0
}

// item を n 個以上持つ。足りない材料は再帰的に集める・作る
export async function obtain (bot, item, n = 1, depth = 0) {
  if (bot.interrupt_code || depth > 6) return false
  if (item === 'log' || LOG_TYPES.includes(item)) return getLogs(bot, n)
  if (item === 'planks_same') return getSamePlanks(bot, n)
  if (item === 'planks' || item.endsWith('_planks')) return getPlanks(bot, n)
  if (item === 'cobblestone' || item === 'stone') return getCobblestone(bot, n)
  if (count(bot, item) >= n) return true
  const recipes = mc.getItemCraftingRecipes(item)
  if (!recipes || !recipes.length) {
    // 作れない物 (鉱石など) は掘る
    const ok = await skills.collectBlock(bot, item, n - count(bot, item))
    return ok && count(bot, item) >= n
  }
  const [ingredients, result] = recipes[0]
  const perCraft = result?.craftedCount || 1
  const times = Math.ceil((n - count(bot, item)) / perCraft)
  // 材料をそろえる (板材は種類を問わない)。棒を作ると板材が減るので、全部そろうまで何周か確かめる
  // 材料の板材は「同じ種類で」そろえる
  const generic = ing => ing.endsWith('_planks') ? 'planks_same' : ing.endsWith('_log') ? 'log' : ing
  for (let pass = 0; pass < 3; pass++) {
    const missing = Object.entries(ingredients).filter(([ing, num]) => count(bot, generic(ing)) < num * times)
    if (!missing.length) break
    for (const [ing, num] of missing) {
      // 板材は、ほかの材料(棒など)に使う分も見込んで多めに
      const extra = generic(ing) === 'planks_same' ? Object.entries(ingredients).filter(([i]) => i === 'stick').reduce((a, [, k]) => a + Math.ceil(k * times / 4) * 2, 0) : 0
      if (!await obtain(bot, generic(ing), num * times + extra, depth + 1)) { skills.log(bot, `${item}の材料 ${ing} がそろわなかった。`); return false }
    }
  }
  // 作業台が要るなら、無ければ作って持つ (craftRecipe が置いて、使ったら回収する)
  if (needsTable(bot, item) && !world.getNearestBlock(bot, 'crafting_table', 16) && count(bot, 'crafting_table') < 1) {
    if (!await obtain(bot, 'crafting_table', 1, depth + 1)) return false
  }
  // クラフトは、サーバーとのずれで失敗することがあるので、少し待って1回だけやり直す
  for (let attempt = 0; attempt < 2 && count(bot, item) < n && !bot.interrupt_code; attempt++) {
    let crafted = false
    try { crafted = await skills.craftRecipe(bot, item, Math.ceil((n - count(bot, item)) / perCraft)) } catch (e) {
      skills.log(bot, `${item}のクラフトでエラー: ${String(e?.message || e).slice(0, 60)}`)
      try { bot.closeWindow(bot.currentWindow) } catch {}
    }
    // 失敗したら、持ち物の情報が落ち着くのを待ってからもう1回
    if (!crafted || count(bot, item) < n) await new Promise(resolve => setTimeout(resolve, 1500))
  }
  return count(bot, item) >= n
}

// 家を建てる場所を探す: 地表で size x size が平ら (高さの差1以内)、水・溶岩・木の幹が無く、
// 上に4マスの空き (葉っぱも無い) がある所。見つかれば南西の角の、地面の1つ上 (空気の高さ)
const PASS = /^(air|cave_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|blue_orchid|lily_of_the_valley|.*_mushroom|sweet_berry_bush)$/
const LEAF = /leaves$/
export function surfaceY (bot, x, z, from) {
  const V = bot.entity.position.constructor
  for (let y = from + 40; y >= from - 40; y--) {
    const b = bot.blockAt(new V(x, y, z))
    if (!b) continue
    if (PASS.test(b.name) || LEAF.test(b.name) || /_log$|vine/.test(b.name)) continue
    return { y: y + 1, top: b.name }
  }
  return null
}

export function findBuildSite (bot, size = 5, radius = 40) {
  const V = bot.entity.position.constructor
  const me = bot.entity.position.floored()
  const s0 = surfaceY(bot, me.x, me.z, me.y)
  const base = s0 ? s0.y : me.y
  const cache = new Map()
  const ground = (x, z) => {
    const k = x + ',' + z
    if (cache.has(k)) return cache.get(k)
    let r = null
    const g = surfaceY(bot, x, z, base)
    if (g && !/water|lava|ice|cactus|magma/.test(g.top) && Math.abs(g.y - base) <= 8) {
      // 上の4マスが空いているか (葉っぱや幹があると家がめり込む)
      let free = true
      for (let dy = 0; dy < 5 && free; dy++) { const b = bot.blockAt(new V(x, g.y + dy, z)); if (!b || !PASS.test(b.name)) free = false }
      if (free) r = g.y
    }
    cache.set(k, r)
    return r
  }
  for (let r = 0; r <= radius; r += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      for (let dz = -r; dz <= r; dz += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const x0 = me.x + dx; const z0 = me.z + dz
        const ys = []
        let ok = true
        for (let i = 0; i < size && ok; i++) for (let j = 0; j < size && ok; j++) { const y = ground(x0 + i, z0 + j); if (y == null) ok = false; else ys.push(y) }
        if (ok && Math.max(...ys) - Math.min(...ys) <= 1) return new V(x0, Math.max(...ys), z0)
      }
    }
  }
  return null
}

function hutSpots (cx, cy, cz, size = 5) {
  const half = Math.floor(size / 2)
  const spots = []
  for (let y = 0; y < 4; y++) {
    for (let dx = -half; dx <= half; dx++) {
      for (let dz = -half; dz <= half; dz++) {
        const edge = Math.abs(dx) === half || Math.abs(dz) === half
        const door = dz === -half && dx === 0 && y < 2
        if (y < 3 ? (edge && !door) : true) spots.push([cx + dx, cy + y, cz + dz])
      }
    }
  }
  return spots
}

const EMPTY = ['air', 'cave_air', 'short_grass', 'tall_grass', 'snow', 'fern']

// 小屋の、まだブロックが置かれていない場所の数
export function remainingHut (bot, cx, cy, cz, size = 5) {
  const V = bot.entity.position.constructor
  return hutSpots(cx, cy, cz, size).filter(([x, y, z]) => { const b = bot.blockAt(new V(x, y, z)); return !b || EMPTY.includes(b.name) }).length
}

// 小屋を建てる。中心 (cx, cy, cz)、5x5、壁3段+屋根。持っている丸石・板材を使う
export async function buildHut (bot, cx, cy, cz, size = 5) {
  const spots = hutSpots(cx, cy, cz, size)
  const material = () => {
    const inv = world.getInventoryCounts(bot)
    return ['cobblestone', 'cobbled_deepslate', ...Object.keys(inv).filter(k => k.endsWith('_planks')), 'dirt']
      .find(k => (inv[k] || 0) > 0)
  }
  let placed = 0
  for (const [x, y, z] of spots) {
    if (bot.interrupt_code) break
    const cur = bot.blockAt(new (bot.entity.position.constructor)(x, y, z))
    if (cur && !EMPTY.includes(cur.name)) continue
    const m = material()
    if (!m) { skills.log(bot, '建材が足りない。'); break }
    if (await skills.placeBlock(bot, m, x, y, z, 'bottom', true)) placed++
  }
  return { placed, total: spots.length }
}
