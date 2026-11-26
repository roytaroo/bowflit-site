// 「○○を手に入れる」を、必要な下ごしらえ込みで自動でやる (LLMに頼らない)。
// 例: 石のツルハシ → (無ければ) 原木を集める → 板材 → 棒 → 作業台 → 木のツルハシ → 石を掘る → 石のツルハシ
import * as skills from './skills.js'
import * as world from './world.js'
import * as mc from './mcdata.js'

const LOG_TYPES = mc.WOOD_TYPES.map(w => w + '_log').concat(['crimson_stem', 'warped_stem'])

export function count (bot, name) {
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
    await skills.collectBlock(bot, type, Math.min(need, 8))
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
  const generic = ing => ing.endsWith('_planks') ? 'planks' : ing.endsWith('_log') ? 'log' : ing
  for (let pass = 0; pass < 3; pass++) {
    const missing = Object.entries(ingredients).filter(([ing, num]) => count(bot, generic(ing)) < num * times)
    if (!missing.length) break
    for (const [ing, num] of missing) {
      // 板材は、ほかの材料(棒など)に使う分も見込んで多めに
      const extra = generic(ing) === 'planks' ? Object.entries(ingredients).filter(([i]) => i === 'stick').reduce((a, [, k]) => a + Math.ceil(k * times / 4) * 2, 0) : 0
      if (!await obtain(bot, generic(ing), num * times + extra, depth + 1)) { skills.log(bot, `${item}の材料 ${ing} がそろわなかった。`); return false }
    }
  }
  // 作業台が要るなら、無ければ作って持つ (craftRecipe が置いて、使ったら回収する)
  if (needsTable(bot, item) && !world.getNearestBlock(bot, 'crafting_table', 16) && count(bot, 'crafting_table') < 1) {
    if (!await obtain(bot, 'crafting_table', 1, depth + 1)) return false
  }
  await skills.craftRecipe(bot, item, times)
  return count(bot, item) >= n
}

// 家を建てる場所を探す: 周りで size x size が平ら (高さの差1以内) で、水や木の無い地面。見つかれば南西の角の足元 (空気の高さ)
export function findBuildSite (bot, size = 7, radius = 20) {
  const V = bot.entity.position.constructor
  const base = bot.entity.position.floored()
  const bad = /water|lava|leaves|_log|ice|snow_block|cactus|bush|vine|bamboo/
  const ground = (x, z) => {
    const top = base.y + 12
    const first = bot.blockAt(new V(x, top, z))
    if (!first || first.boundingBox === 'block') return null // 山の中や木の上かもしれないので使わない
    for (let y = top - 1; y >= base.y - 12; y--) {
      const b = bot.blockAt(new V(x, y, z))
      if (!b) return null
      if (b.name === 'air' || b.name === 'cave_air' || /grass$|fern|flower|poppy|dandelion|snow$/.test(b.name) && b.boundingBox !== 'block') continue
      if (bad.test(b.name) || b.boundingBox !== 'block') return null
      return y + 1
    }
    return null
  }
  let best = null
  for (let r = 0; r <= radius && !best; r += 2) {
    for (let dx = -r; dx <= r && !best; dx += 2) {
      for (let dz = -r; dz <= r && !best; dz += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const x0 = base.x + dx; const z0 = base.z + dz
        const ys = []
        let ok = true
        for (let i = 0; i < size && ok; i++) for (let j = 0; j < size && ok; j++) { const y = ground(x0 + i, z0 + j); if (y == null) ok = false; else ys.push(y) }
        if (ok && Math.max(...ys) - Math.min(...ys) <= 1 && Math.abs(Math.max(...ys) - base.y) <= 6) best = new V(x0, Math.max(...ys), z0)
      }
    }
  }
  return best
}

// 小屋を建てる。中心 (cx, cy, cz)、5x5、壁3段+屋根。持っている丸石・板材を使う
export async function buildHut (bot, cx, cy, cz, size = 5) {
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
  const material = () => {
    const inv = world.getInventoryCounts(bot)
    return ['cobblestone', 'cobbled_deepslate', ...Object.keys(inv).filter(k => k.endsWith('_planks')), 'dirt']
      .find(k => (inv[k] || 0) > 0)
  }
  let placed = 0
  for (const [x, y, z] of spots) {
    if (bot.interrupt_code) break
    const cur = bot.blockAt(new (bot.entity.position.constructor)(x, y, z))
    if (cur && !['air', 'cave_air', 'short_grass', 'tall_grass', 'snow'].includes(cur.name)) continue
    const m = material()
    if (!m) { skills.log(bot, '建材が足りない。'); break }
    if (await skills.placeBlock(bot, m, x, y, z, 'bottom', true)) placed++
  }
  return { placed, total: spots.length }
}
