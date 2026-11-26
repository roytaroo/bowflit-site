// ゲームの状態を「LLMが読める短い要約」に変換する。ここは通常のプログラム (LLMを使わない)。

export const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch',
  'enderman', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex',
  'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'guardian', 'elder_guardian',
  'silverfish', 'endermite', 'shulker', 'warden', 'wither', 'ender_dragon', 'breeze', 'zombie_villager'
])
// 安全管理で「絶対に戦わない」相手 (設定で解禁可能)
export const DEADLY = new Set(['warden', 'wither', 'ender_dragon', 'ravager', 'elder_guardian', 'evoker'])

export const FOOD = new Set([
  'bread', 'apple', 'golden_apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
  'cooked_cod', 'cooked_salmon', 'baked_potato', 'carrot', 'beetroot', 'melon_slice', 'sweet_berries', 'glow_berries',
  'pumpkin_pie', 'cookie', 'mushroom_stew', 'beetroot_soup', 'rabbit_stew', 'beef', 'porkchop', 'chicken', 'mutton',
  'rabbit', 'cod', 'salmon', 'potato', 'dried_kelp'
])

const INTERESTING = [
  ['log', n => n.endsWith('_log')], ['石', n => n === 'stone' || n === 'cobblestone'],
  ['石炭鉱石', n => n.includes('coal_ore')], ['鉄鉱石', n => n.includes('iron_ore')],
  ['銅鉱石', n => n.includes('copper_ore')], ['金鉱石', n => n.includes('gold_ore')],
  ['ダイヤ鉱石', n => n.includes('diamond_ore')], ['水', n => n === 'water'], ['溶岩', n => n === 'lava'],
  ['小麦', n => n === 'wheat'], ['ベッド', n => n.endsWith('_bed')], ['チェスト', n => n === 'chest'],
  ['作業台', n => n === 'crafting_table'], ['かまど', n => n === 'furnace'], ['花', n => /(dandelion|poppy|tulip|orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley)$/.test(n)]
]

export function dayPhase (timeOfDay) {
  if (timeOfDay == null) return '昼'
  if (timeOfDay < 1000) return '早朝'
  if (timeOfDay < 6000) return '朝'
  if (timeOfDay < 11000) return '昼'
  if (timeOfDay < 12500) return '夕方'
  if (timeOfDay < 23000) return '夜'
  return '夜明け前'
}

export function isNight (timeOfDay) {
  return timeOfDay != null && timeOfDay >= 12500 && timeOfDay < 23000
}

const TIER = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite']
export function gearTier (items) {
  let weapon = -1; let armor = 0
  for (const it of items) {
    const m = it.name.match(/^(wooden|stone|golden|iron|diamond|netherite)_(sword|axe)$/)
    if (m) weapon = Math.max(weapon, TIER.indexOf(m[1]))
    if (/_(helmet|chestplate|leggings|boots)$/.test(it.name)) armor++
  }
  return { weapon, armor, label: weapon < 0 ? '素手' : TIER[weapon] + '武器' }
}

export function round (v) { return v == null ? null : Math.round(v) }

export function snapshot (bot, { home = null, scanBlocks = true, knownAgents = [] } = {}) {
  const me = bot.entity
  const pos = me?.position
  const items = (bot.inventory?.items?.() || []).map(i => ({ name: i.name, count: i.count }))
  const merged = {}
  for (const i of items) merged[i.name] = (merged[i.name] || 0) + i.count
  const inv = Object.entries(merged).map(([name, count]) => ({ name, count }))

  const hostiles = []; const players = []; const animals = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === me || !e.position || !pos) continue
    const d = e.position.distanceTo(pos)
    if (d > 32) continue
    const name = e.name || e.username || e.displayName
    if (e.type === 'player') players.push({ name: e.username, dist: Math.round(d), isAgent: knownAgents.includes(e.username) })
    else if (HOSTILE.has(name)) hostiles.push({ name, dist: Math.round(d), id: e.id })
    else if (e.type === 'animal' || e.type === 'passive' || ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(name)) animals.push({ name, dist: Math.round(d) })
  }
  hostiles.sort((a, b) => a.dist - b.dist)
  players.sort((a, b) => a.dist - b.dist)

  const blocks = {}
  if (scanBlocks && bot.findBlocks && pos) {
    try {
      const found = bot.findBlocks({ matching: b => b && b.name !== 'air' && INTERESTING.some(([, f]) => f(b.name)), maxDistance: 16, count: 200 })
      for (const p of found) {
        const b = bot.blockAt(p)
        if (!b) continue
        const cat = INTERESTING.find(([, f]) => f(b.name))
        if (!cat) continue
        const key = cat[0] === 'log' ? b.name : cat[0]
        blocks[key] = blocks[key] || { count: 0, nearest: Infinity }
        blocks[key].count++
        blocks[key].nearest = Math.min(blocks[key].nearest, Math.round(p.distanceTo(pos)))
      }
    } catch { /* ワールド未ロード時など */ }
  }

  const timeOfDay = bot.time?.timeOfDay
  return {
    pos: pos ? { x: round(pos.x), y: round(pos.y), z: round(pos.z) } : null,
    health: bot.health ?? 20,
    food: bot.food ?? 20,
    timeOfDay,
    day: bot.time?.day ?? null,
    phase: dayPhase(timeOfDay),
    night: isNight(timeOfDay),
    raining: !!bot.isRaining,
    dimension: bot.game?.dimension || 'overworld',
    inventory: inv,
    gear: gearTier(inv),
    foodItems: inv.filter(i => FOOD.has(i.name)),
    hostiles,
    players,
    animals: animals.slice(0, 5),
    blocks,
    home,
    distHome: home && pos ? Math.round(Math.hypot(pos.x - home.x, pos.z - home.z)) : null,
    inWater: !!me?.isInWater,
    oxygen: bot.oxygenLevel ?? null,
    inLava: !!me?.isInLava,
    onFire: !!(me?.metadata && (me.metadata[0] & 0x01))
  }
}

export function describeState (s) {
  const inv = s.inventory.length ? s.inventory.map(i => `${i.name}x${i.count}`).join(', ') : 'なし'
  const hostile = s.hostiles.length ? s.hostiles.slice(0, 4).map(h => `${h.name}(${h.dist}m)`).join(', ') : 'なし'
  const players = s.players.length ? s.players.slice(0, 8).map(p => `${p.name}(${p.dist}m)`).join(', ') : '近くに誰もいない'
  const blocks = Object.entries(s.blocks).map(([k, v]) => `${k}${v.count}個(最寄り${v.nearest}m)`).join(', ') || '特になし'
  return [
    `時間: ${s.day != null ? `${s.day}日目 ` : ''}${s.phase}${s.raining ? ' 雨' : ''}`,
    `体力 ${s.health}/20, 満腹度 ${s.food}/20, 装備 ${s.gear.label}・防具${s.gear.armor}部位`,
    `位置 ${s.pos ? `${s.pos.x},${s.pos.y},${s.pos.z}` : '不明'}${s.home ? ` / 家まで${s.distHome}m` : ' / まだ家がない'}`,
    `持ち物: ${inv}`,
    `近くの人: ${players}`,
    `近くの敵: ${hostile}`,
    `周囲のブロック: ${blocks}`
  ].join('\n')
}
