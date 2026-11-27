// 行動の中身を Mindcraft のスキル (src/body) で実行する版。actions.js の同じ名前の行動を上書きする。
// 説明文 (desc/args) は LLM に見せるので、元の行動と同じにしてある。
// どれも「結果を日本語の短い文」で返す。skills が書く英語のログ (bot.output) は、失敗したときの理由として使う。
import { Vec3 } from 'vec3'
import * as skills from '../body/skills.js'
import * as world from '../body/world.js'
import * as plan from '../body/plan.js'

const BEDS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(c => c + '_bed')
const nearestBed = (bot, d) => world.getNearestBlocks(bot, BEDS, d, 1)[0] || null

const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'bread', 'baked_potato', 'golden_carrot', 'apple', 'carrot', 'sweet_berries', 'melon_slice', 'cookie', 'pumpkin_pie', 'beetroot', 'potato', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon']

function why (bot) {
  const out = String(bot.output || '').trim().split('\n').filter(Boolean)
  return out.length ? out[out.length - 1].slice(0, 120) : ''
}

function nameOf (ctx, a) {
  const raw = a.name ?? a.player ?? a.target ?? a.to ?? a.who ?? a.with
  if (!raw) return ctx.agent.lastHumanSpeaker || ctx.agent.cfg?.player?.name || null
  return ctx.agent.society.resolveName?.(String(raw)) || String(raw)
}

// 「木」「石」などの言い方を、集める物の名前に
function normalizeBlock (b) {
  const s = String(b || '').toLowerCase()
  if (/^(log|wood|木|原木)$/.test(s) || s.endsWith('_log')) return 'log'
  if (/^(stone|cobblestone|石|丸石)$/.test(s)) return 'cobblestone'
  if (/^(coal|coal_ore|石炭)$/.test(s)) return 'coal'
  if (/^(iron|iron_ore|鉄)$/.test(s)) return 'iron_ore'
  if (/^(diamond|diamond_ore|ダイヤ)$/.test(s)) return 'diamond'
  if (/^(dirt|土)$/.test(s)) return 'dirt'
  if (/^(sand|砂)$/.test(s)) return 'sand'
  return s
}

export const BODY_ACTIONS = {
  go_to: {
    async run (ctx, a) {
      const { bot } = ctx
      const y = a.y ?? bot.entity.position.y
      const ok = await skills.goToPosition(bot, Number(a.x), Number(y), Number(a.z), 2)
      return ok ? `(${a.x},${a.z})に着いた` : `(${a.x},${a.z})にたどり着けなかった (${why(bot)})`
    }
  },
  go_home: {
    async run (ctx) {
      const h = ctx.agent.home
      if (!h) return 'まだ家がない'
      const ok = await skills.goToPosition(ctx.bot, h.x, h.y, h.z, 2)
      return ok ? '家に帰ってきた' : '家にたどり着けなかった'
    }
  },
  go_to_player: {
    async run (ctx, a) {
      const name = nameOf(ctx, a)
      if (!name) return '誰のところへ行くか分からない'
      const ok = await skills.goToPlayer(ctx.bot, name, 3)
      return ok ? `${name}のそばに来た` : `${name}のところへ行けなかった (${why(ctx.bot)})`
    }
  },
  follow: {
    async run (ctx, a) {
      const name = nameOf(ctx, a)
      if (!name || !ctx.bot.players[name]?.entity) return `${name || '相手'}が見当たらない`
      const sec = Math.min(180, Number(a.seconds) || 60)
      const t = setTimeout(() => ctx.agent.body?.requestInterrupt(), sec * 1000)
      try { await skills.followPlayer(ctx.bot, name, 3) } finally { clearTimeout(t) }
      return `${name}について行った`
    }
  },
  explore: {
    async run (ctx, a) {
      const { bot } = ctx
      const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], 北: [0, -1], 南: [0, 1], 東: [1, 0], 西: [-1, 0] }
      const d = dirs[a.direction] || Object.values(dirs)[Math.floor(Math.random() * 4)]
      const dist = Math.min(96, Number(a.distance) || 48)
      const p = bot.entity.position
      const ok = await skills.goToPosition(bot, Math.round(p.x + d[0] * dist), p.y, Math.round(p.z + d[1] * dist), 4)
      if (ok) ctx.agent.society.recordDiscovery?.(ctx.agent.name, bot.entity.position)
      return ok ? `${a.direction || 'あちこち'}へ${dist}m探索した` : `探索を途中でやめた (${Math.round(bot.entity.position.distanceTo(p))}m進んだ)`
    }
  },
  wander: {
    async run (ctx, a) {
      const { bot } = ctx
      const r = Math.min(24, Number(a.radius) || 10)
      const p = bot.entity.position
      await skills.goToPosition(bot, Math.round(p.x + (Math.random() * 2 - 1) * r), p.y, Math.round(p.z + (Math.random() * 2 - 1) * r), 2)
      return '近くを散歩した'
    }
  },
  collect: {
    async run (ctx, a) {
      const { bot } = ctx
      const block = normalizeBlock(a.block)
      const want = Math.max(1, Math.min(32, Number(a.count) || 8))
      if (!block) return '何を集めるか分からない'
      // 原木・丸石は「手に入れる」で集める (道具が無ければ作るところから)
      if (block === 'log' || block === 'cobblestone') {
        const before = plan.count(bot, block)
        const ok = await plan.obtain(bot, block, before + want)
        const got = plan.count(bot, block) - before
        if (got > 0) return `${block === 'log' ? '原木' : '丸石'}を${got}個集めた`
        return `${block === 'log' ? '原木' : '丸石'}を集められなかった (${ok ? '' : why(bot)})`
      }
      // 鉱石は、掘れるツルハシを先に用意する
      if (/iron|copper|lapis/.test(block) && !bot.inventory.items().some(i => /(stone|iron|diamond|netherite)_pickaxe/.test(i.name))) await plan.obtain(bot, 'stone_pickaxe', 1)
      if (/coal|_ore|diamond|redstone|emerald|gold/.test(block) && !bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) await plan.obtain(bot, 'wooden_pickaxe', 1)
      const before = bot.inventory.items().reduce((n, i) => n + i.count, 0)
      const ok = await skills.collectBlock(bot, block, want)
      const got = bot.inventory.items().reduce((n, i) => n + i.count, 0) - before
      return ok && got > 0 ? `${a.block}を集めた (持ち物+${got})` : `${a.block}を集められなかった (${why(bot)})`
    }
  },
  craft: {
    async run (ctx, a) {
      const { bot } = ctx
      const item = String(a.item || '')
      if (!item) return '何を作るか分からない'
      if (/_ore$|^stone$|^cobblestone$|_log$|^dirt$|^sand$/.test(item)) return `${item}は作れない。collect で集めること`
      const n = Math.max(1, Math.min(64, Number(a.count) || 1))
      const before = plan.count(bot, item)
      // 材料が無ければ集めるところから自動でやる
      const ok = await plan.obtain(bot, item, before + n)
      const made = plan.count(bot, item) - before
      return made > 0 ? `${item}を${made}個作った` : `${item}を作れなかった (${ok ? '' : why(bot)})`
    }
  },
  eat: {
    async run (ctx) {
      const { bot } = ctx
      if (bot.food >= 20) return 'お腹がいっぱい'
      const food = FOODS.find(f => bot.inventory.items().some(i => i.name === f))
      if (!food) return '食べ物を持っていない'
      await skills.consume(bot, food)
      return `${food}を食べた`
    }
  },
  sleep: {
    async run (ctx) {
      const { bot, agent } = ctx
      // ベッドのそばで待つ・寝ている間は「はまった」と思われて動かされないように
      for (const m of ['unstuck', 'elbow_room', 'item_collecting', 'torch_placing']) bot.modes?.pause(m)
      // 自分のベッド (みんなの家) があれば、そこへ帰って寝る
      if (agent.bedPos) {
        const bp = new Vec3(agent.bedPos.x, agent.bedPos.y, agent.bedPos.z)
        if (bot.entity.position.distanceTo(bp) > 3) await skills.goToPosition(bot, bp.x, bp.y, bp.z, 2)
        if (bot.interrupt_code) return '家に帰る途中で中断した'
        const bed = bot.blockAt(bp)
        if (!bed || !bed.name.endsWith('_bed')) return '自分のベッドが無くなっていた'
        // まだ寝られる時間でなければ、ベッドのそばで少し待つ (最大90秒)
        for (let i = 0; i < 30 && !bot.interrupt_code; i++) {
          try { await bot.sleep(bed); break } catch (e) {
            if (/occupied/i.test(e.message)) return '自分のベッドに誰かが寝ていた'
            if (/monster|enemies|安全/i.test(e.message)) return '近くにモンスターがいて眠れない'
            await new Promise(resolve => setTimeout(resolve, 3000))
          }
        }
        if (!bot.isSleeping) return '眠れなかった (まだ夜じゃない)'
        while (bot.isSleeping && !bot.interrupt_code) await new Promise(resolve => setTimeout(resolve, 1000))
        return 'ぐっすり眠った'
      }
      // 家が無いとき: 近くのベッドか、持っているベッドを置いて寝る
      let bed = nearestBed(bot, 32)
      const item = bot.inventory.items().find(i => i.name.endsWith('_bed'))
      if (!bed && item) {
        const p = world.getNearestFreeSpace(bot, 2, 6)
        if (p && await skills.placeBlock(bot, item.name, p.x, p.y, p.z)) {
          bed = nearestBed(bot, 6)
          if (bed) { agent.bedPos = { x: bed.position.x, y: bed.position.y, z: bed.position.z }; ctx.store?.setState?.(`bed:${agent.name}`, agent.bedPos) }
        }
      }
      if (!bed) return '近くにベッドがない'
      const ok = await skills.goToBed(bot)
      return ok ? 'ぐっすり眠った' : `眠れなかった (${why(bot)})`
    }
  },
  attack: {
    async run (ctx, a) {
      const { bot } = ctx
      let t = String(a.target || '')
      if (bot.players[t] || ctx.agent.society.isAgent(t)) return 'プレイヤーは攻撃しない'
      // 「動物」なら近くの食べられる動物 (牛・豚・羊・鶏) を探す。いなければ少し歩いて探す
      if (/^(animal|food|動物)$/.test(t)) {
        const ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit']
        let e = bot.nearestEntity(en => ANIMALS.includes(en.name) && en.position.distanceTo(bot.entity.position) < 32)
        if (!e) {
          const p = bot.entity.position; const ang = Math.random() * Math.PI * 2
          await skills.goToPosition(bot, Math.round(p.x + Math.cos(ang) * 40), p.y, Math.round(p.z + Math.sin(ang) * 40), 4)
          e = bot.nearestEntity(en => ANIMALS.includes(en.name) && en.position.distanceTo(bot.entity.position) < 32)
        }
        if (!e) return '近くに動物がいなかった'
        t = e.name
      }
      const ok = await skills.attackNearest(bot, t, true)
      return ok ? `${t}を倒した` : `${t}を倒せなかった (${why(bot)})`
    }
  },
  flee: {
    async run (ctx) {
      await skills.avoidEnemies(ctx.bot, 20)
      return '危険から逃げた'
    }
  },
  escape_hazard: {
    async run (ctx) {
      await skills.moveAway(ctx.bot, 6)
      return '危険な場所から離れた'
    }
  },
  give: {
    async run (ctx, a) {
      const { bot } = ctx
      const to = nameOf(ctx, { name: a.to ?? a.name ?? a.player })
      let item = String(a.item || '')
      // 「oak_log」と言われて spruce_log しか無ければ、ある原木を渡す
      if (!bot.inventory.items().some(i => i.name === item)) {
        const alt = bot.inventory.items().find(i => (item.endsWith('_log') && i.name.endsWith('_log')) || (item.endsWith('_planks') && i.name.endsWith('_planks')))
        if (alt) item = alt.name
      }
      const have = bot.inventory.items().filter(i => i.name === item).reduce((n, i) => n + i.count, 0)
      if (!have) return `${a.item}を持っていない`
      const n = Math.min(have, Number(a.count) || 1)
      const ok = await skills.giveToPlayer(bot, item, to, n)
      if (ok) ctx.agent.onGave?.(to, item, n)
      return ok ? `${to}に${item}を${n}個渡した` : `${to}に渡せなかった (${why(bot)})`
    }
  },
  store_items: {
    async run (ctx) {
      const { bot } = ctx
      let chest = world.getNearestBlock(bot, 'chest', 32)
      if (!chest && bot.inventory.items().some(i => i.name === 'chest')) {
        const p = world.getNearestFreeSpace(bot, 1, 6)
        if (p) await skills.placeBlock(bot, 'chest', p.x, p.y, p.z)
        chest = world.getNearestBlock(bot, 'chest', 8)
      }
      if (!chest) return '近くにチェストがない (chestを作って家に置くと良い)'
      let n = 0
      // しまうのは、普段使わない物だけ (道具・食べ物・建材・松明は手元に残す)
      const keep = /_(sword|pickaxe|axe|shovel|hoe)$|_bed$|^torch$|_log$|_planks$|^cobblestone$|^cobbled_deepslate$|^stick$|^crafting_table$|^chest$|^coal$|_ingot$/
      const names = [...new Set(bot.inventory.items().map(i => i.name))].filter(nm => !keep.test(nm) && !FOODS.includes(nm))
      for (const nm of names) {
        const c = bot.inventory.items().filter(i => i.name === nm).reduce((k, i) => k + i.count, 0)
        if (!c) continue
        try { if (await skills.putInChest(bot, nm, c)) n += c } catch {}
        if (bot.interrupt_code) break
      }
      return n ? `チェストに${n}個しまった` : 'しまう物がなかった'
    }
  },
  build_house: {
    async run (ctx) {
      const { bot, agent } = ctx
      const key = `build:${agent.name}:house`
      // 建材を用意: 残りのブロック数ぶん (はじめは71個)。板材を中心に、足りなければ丸石も
      const mats = () => plan.count(bot, 'cobblestone') + plan.count(bot, 'planks')
      const need = agent.houseSite ? plan.remainingHut(bot, agent.houseSite.x, agent.houseSite.y, agent.houseSite.z) : 71
      if (mats() < need) await plan.obtain(bot, 'planks', Math.min(64, plan.count(bot, 'planks') + need - mats()))
      if (mats() < need) await plan.obtain(bot, 'cobblestone', plan.count(bot, 'cobblestone') + need - mats())
      if (bot.interrupt_code) return '家づくりを中断した'
      // 場所: 家の場所が決まっていればそこ、無ければ近くの平らな所を家にする
      let site = agent.houseSite
      if (!site) {
        if (agent.home) await skills.goToPosition(bot, agent.home.x, agent.home.y, agent.home.z, 3)
        let s = plan.findBuildSite(bot, 5, 40)
        // 見つからなければ、少し歩いて別の場所で探す
        for (let k = 0; !s && k < 3 && !bot.interrupt_code; k++) {
          const p = bot.entity.position; const ang = Math.random() * Math.PI * 2
          await skills.goToPosition(bot, Math.round(p.x + Math.cos(ang) * 48), p.y, Math.round(p.z + Math.sin(ang) * 48), 4)
          s = plan.findBuildSite(bot, 5, 40)
        }
        if (!s) return '家を建てる平らな場所が見つからない'
        site = { x: s.x + 2, y: s.y, z: s.z + 2 }
        agent.houseSite = site
        ctx.store?.setState?.(`house_site:${agent.name}`, site)
        if (!agent.home) agent.setHome?.({ x: site.x, y: site.y, z: site.z })
      }
      await skills.goToPosition(bot, site.x, site.y, site.z - 3, 2)
      const r = await plan.buildHut(bot, site.x, site.y, site.z)
      const progress = 1 - plan.remainingHut(bot, site.x, site.y, site.z) / r.total
      ctx.store?.setState?.(key, Math.round(progress * 70))
      if (progress >= 0.95) return `家が完成した！ (${site.x},${site.z})`
      return `家を建てている: ${r.placed}ブロック置いた (進み具合${Math.round(progress * 100)}%)。${r.placed < 5 ? '建材が足りないかも' : ''}`
    }
  },
  set_home: {
    async run (ctx) {
      const { bot, agent } = ctx
      // 家は地表の平らな所に決める (掘った穴の底などにしない)
      const s = plan.findBuildSite(bot, 5, 40)
      if (s) {
        const site = { x: s.x + 2, y: s.y, z: s.z + 2 }
        agent.houseSite = site
        ctx.store?.setState?.(`house_site:${agent.name}`, site)
        agent.setHome({ x: site.x, y: site.y, z: site.z - 3 })
        return `(${site.x},${site.z})を自分の家の場所にした`
      }
      const p = bot.entity.position.floored()
      agent.setHome({ x: p.x, y: p.y, z: p.z })
      return `ここ(${p.x},${p.z})を自分の家にした`
    }
  },
  rest: {
    async run (ctx, a) {
      ctx.bot.modes?.pause('unstuck')
      const sec = Math.min(60, Number(a.seconds) || 5)
      for (let i = 0; i < sec * 2 && !ctx.bot.interrupt_code; i++) await new Promise(resolve => setTimeout(resolve, 500))
      return '少し休んだ'
    }
  }
}
