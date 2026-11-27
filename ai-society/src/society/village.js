// 村の家: 最初の起動で、スポーン近くに全員が住める家をサーバーのコマンド (fill / setblock) で建てる。
// 中には住人の人数分のベッド (キャラのイメージカラー)、ラージチェスト、作業台、かまど、松明。
// 建てた場所とベッドの位置は store に保存して、夜はそこに帰って寝る。
import { log } from '../util/log.js'

// ベッドの色 (16色) の見本の色
const DYES = {
  white: [249, 255, 254], orange: [249, 128, 29], magenta: [199, 78, 189], light_blue: [58, 179, 218], yellow: [254, 216, 61],
  lime: [128, 199, 31], pink: [243, 139, 170], gray: [71, 79, 82], light_gray: [157, 157, 151], cyan: [22, 156, 156],
  purple: [137, 50, 184], blue: [60, 68, 170], brown: [131, 84, 50], green: [94, 124, 22], red: [176, 46, 38], black: [29, 29, 33]
}

// キャラのイメージカラー (#RRGGBB) にいちばん近いベッドの色
export function bedColor (hex) {
  const n = parseInt(String(hex || '#ffffff').replace('#', ''), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  let best = 'white'; let bestD = Infinity
  for (const [name, c] of Object.entries(DYES)) {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2
    if (d < bestD) { bestD = d; best = name }
  }
  return best
}

// 家の設計図。(x0, y, z0) が南西の角の床の上 (人が立つ高さ)。residents は全キャラ (11人分ベッドを置く)
// 返り値: { commands: [...], beds: {username: {x,y,z}}, chest, door, center, size }
export function houseBlueprint (x0, y, z0, residents) {
  const n = residents.length
  const W = Math.max(9, n + 2) // 内側の幅 (東西)。ベッドを奥の壁にずらっと並べる
  const D = 7 // 内側の奥行き (南北)
  const x1 = x0 + W + 1; const z1 = z0 + D + 1 // 外壁の角
  const cmds = []
  // 地ならし: 床の下を土で埋め、家の範囲の上を空ける (少し広めに)
  cmds.push(`fill ${x0 - 1} ${y - 5} ${z0 - 2} ${x1 + 1} ${y - 2} ${z1 + 1} dirt replace air`)
  cmds.push(`fill ${x0 - 1} ${y - 5} ${z0 - 2} ${x1 + 1} ${y - 2} ${z1 + 1} dirt replace water`)
  cmds.push(`fill ${x0 - 1} ${y - 1} ${z0 - 2} ${x1 + 1} ${y - 1} ${z1 + 1} grass_block replace air`)
  cmds.push(`fill ${x0 - 1} ${y} ${z0 - 2} ${x1 + 1} ${y + 7} ${z1 + 1} air`)
  // 箱: 床 (y-1)、壁 (y..y+3)、屋根 (y+4)。中は空気
  cmds.push(`fill ${x0} ${y - 1} ${z0} ${x1} ${y + 4} ${z1} spruce_planks hollow`)
  cmds.push(`fill ${x0} ${y - 1} ${z0} ${x1} ${y - 1} ${z1} oak_planks`)
  // 角の柱
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) cmds.push(`fill ${x} ${y - 1} ${z} ${x} ${y + 4} ${z} oak_log`)
  // 屋根のふち
  cmds.push(`fill ${x0 - 1} ${y + 4} ${z0 - 1} ${x1 + 1} ${y + 4} ${z1 + 1} dark_oak_planks replace air`)
  // 窓 (南北の壁に2つずつ、東西に1つずつ)
  const wx = [x0 + 2, x1 - 2]
  for (const x of wx) { cmds.push(`fill ${x} ${y + 1} ${z0} ${x} ${y + 2} ${z0} glass_pane`); cmds.push(`fill ${x} ${y + 1} ${z1} ${x} ${y + 2} ${z1} glass_pane`) }
  const mz = z0 + Math.floor((D + 1) / 2)
  cmds.push(`fill ${x0} ${y + 1} ${mz} ${x0} ${y + 2} ${mz} glass_pane`)
  cmds.push(`fill ${x1} ${y + 1} ${mz} ${x1} ${y + 2} ${mz} glass_pane`)
  // 入口 (南の壁のまん中) にドア
  const dx = x0 + Math.floor((W + 1) / 2)
  cmds.push(`setblock ${dx} ${y} ${z0} oak_door[facing=north,half=lower,hinge=left]`)
  cmds.push(`setblock ${dx} ${y + 1} ${z0} oak_door[facing=north,half=upper,hinge=left]`)
  cmds.push(`setblock ${dx} ${y + 2} ${z0 - 1} wall_torch[facing=north]`)
  // ベッド: 奥 (北の壁) に頭を向けて1列に。足が z1-2、頭が z1-1
  const beds = {}
  residents.forEach((c, i) => {
    const x = x0 + 1 + i
    const color = bedColor(c.color)
    cmds.push(`setblock ${x} ${y} ${z1 - 1} ${color}_bed[facing=south,part=head]`)
    cmds.push(`setblock ${x} ${y} ${z1 - 2} ${color}_bed[facing=south,part=foot]`)
    beds[c.username] = { x, y, z: z1 - 1 }
  })
  // ラージチェスト (入口の左に2つ並べる)、作業台、かまど (入口の右)
  const chest = { x: x0 + 1, y, z: z0 + 1 }
  cmds.push(`setblock ${x0 + 1} ${y} ${z0 + 1} chest[facing=north,type=right]`)
  cmds.push(`setblock ${x0 + 2} ${y} ${z0 + 1} chest[facing=north,type=left]`)
  cmds.push(`setblock ${x1 - 1} ${y} ${z0 + 1} crafting_table`)
  cmds.push(`setblock ${x1 - 2} ${y} ${z0 + 1} furnace[facing=north]`)
  // 中の明かり
  cmds.push(`setblock ${x0 + 1} ${y + 2} ${mz} wall_torch[facing=east]`)
  cmds.push(`setblock ${x1 - 1} ${y + 2} ${mz} wall_torch[facing=west]`)
  const center = { x: dx, y, z: z0 + 3 }
  return { commands: cmds, beds, chest, door: { x: dx, y, z: z0 }, center, size: { x0, z0, x1, z1, y } }
}

// 家を建てる場所: スポーン付近で、地面の高さのばらつきが小さい所 (コマンドで地ならしするので多少の凸凹はよい)
export function chooseSite (bot, origin, w, d) {
  const V = bot.entity.position.constructor
  const surface = (x, z) => {
    for (let y = Math.min(origin.y + 30, 300); y > origin.y - 30; y--) {
      const b = bot.blockAt(new V(x, y, z))
      if (!b) return null
      if (/^(air|cave_air|short_grass|tall_grass|fern|large_fern|snow|.*_flower|dandelion|poppy|.*_tulip)$/.test(b.name) || /leaves$|_log$|vine/.test(b.name)) continue
      if (/water|lava|ice/.test(b.name)) return null
      return y + 1
    }
    return null
  }
  let best = null
  for (let r = 0; r <= 32; r += 4) {
    for (let ox = -r; ox <= r; ox += 4) {
      for (let oz = -r; oz <= r; oz += 4) {
        if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue
        const x0 = Math.floor(origin.x) + ox; const z0 = Math.floor(origin.z) + oz
        const ys = []
        let ok = true
        for (let i = 0; i <= w + 2 && ok; i += 2) for (let j = 0; j <= d + 2 && ok; j += 2) { const y = surface(x0 + i, z0 + j); if (y == null) ok = false; else ys.push(y) }
        if (!ok) continue
        ys.sort((a, b) => a - b)
        const spread = ys[ys.length - 1] - ys[0]
        const median = ys[Math.floor(ys.length / 2)]
        const score = spread + r * 0.1
        if (spread <= 4 && (!best || score < best.score)) best = { x0, z0, y: median, score }
      }
    }
    if (best) break
  }
  return best
}

// 村の家がまだ無ければ建てる。bot は参加済みの住人の1人。all は全キャラ (まだ参加していない人の分のベッドも置く)
export async function ensureVillage ({ society, bot, all, send = c => console.log('@@CMD ' + c) }) {
  const saved = society.store.getState('village', null)
  if (saved) return saved
  const origin = bot.spawnPoint && bot.spawnPoint.y ? bot.spawnPoint : bot.entity.position
  try { await bot.waitForChunksToLoad() } catch {}
  const w = Math.max(9, all.length + 2) + 2; const d = 9
  const site = chooseSite(bot, origin, w, d)
  const s = site || { x0: Math.floor(bot.entity.position.x) + 3, z0: Math.floor(bot.entity.position.z) + 3, y: Math.floor(bot.entity.position.y) }
  const plan = houseBlueprint(s.x0, s.y, s.z0, all)
  for (const c of plan.commands) send(c)
  const village = { beds: plan.beds, chest: plan.chest, door: plan.door, center: plan.center, size: plan.size, built_at: Date.now() }
  society.store.setState('village', village)
  society.shared.add('village', `みんなの家が(${plan.center.x},${plan.center.z})にできた`, { importance: 6, participants: all.map(c => c.username) })
  log.info('village', `みんなの家を建てた (${plan.center.x},${plan.center.y},${plan.center.z})。ベッド${Object.keys(plan.beds).length}個・ラージチェスト・作業台・かまど`)
  return village
}
