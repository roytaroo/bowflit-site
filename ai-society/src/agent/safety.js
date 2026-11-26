// 安全管理。LLMの判断に依存せず、通常のプログラムで危険な行動を止める。
// 1) reflex(): 毎秒チェックする反射行動 (逃げる・食べる・溶岩から離れる)
// 2) vet():    LLMが選んだ行動を実行前に審査し、却下・修正する
import { DEADLY } from './perception.js'

const EXPLORE_LIMIT_BY_WEAPON = [64, 96, 128, 160, 256, 384, 512] // index = weapon tier + 1

export class Safety {
  constructor (cfg = {}, agentRow = {}) {
    this.cfg = {
      flee_health: 8,
      no_combat_health: 12,
      eat_food_level: 14,
      allow_deadly_bosses: false,
      night_explore: false,
      ...cfg
    }
    this.caution = agentRow.caution || 0 // 死亡するたびに上がる
  }

  setCaution (c) { this.caution = c }

  get fleeHealth () { return Math.min(16, this.cfg.flee_health + this.caution) }
  get noCombatHealth () { return Math.min(18, this.cfg.no_combat_health + this.caution) }

  exploreLimit (s) {
    const base = EXPLORE_LIMIT_BY_WEAPON[Math.max(0, s.gear.weapon + 1)] || 64
    const armorBonus = s.gear.armor * 16
    return Math.round((base + armorBonus) / (1 + this.caution * 0.25))
  }

  // 緊急時の反射行動。null なら何もしない
  reflex (s) {
    if (s.inLava || s.onFire) return { name: 'escape_hazard', args: {}, reason: '溶岩/火から離れる' }
    const near = s.hostiles.filter(h => h.dist <= 10)
    if (s.health <= this.fleeHealth && near.length) {
      return { name: 'flee', args: { from: near[0].name }, reason: `体力${s.health}で${near[0].name}が接近` }
    }
    if (near.some(h => h.name === 'creeper' && h.dist <= 5)) {
      return { name: 'flee', args: { from: 'creeper' }, reason: 'クリーパーが至近距離' }
    }
    if (near.some(h => DEADLY.has(h.name)) && !this.cfg.allow_deadly_bosses) {
      return { name: 'flee', args: { from: near.find(h => DEADLY.has(h.name)).name }, reason: '勝てない相手' }
    }
    if (s.food <= this.cfg.eat_food_level && s.foodItems.length) {
      return { name: 'eat', args: {}, reason: `満腹度${s.food}` }
    }
    return null
  }

  // LLMの行動案を審査。{ ok, action, reason }
  vet (action, s) {
    if (!action || !action.name) return { ok: false, reason: '行動が指定されていない' }
    const a = { name: action.name, args: { ...(action.args || {}) } }
    switch (a.name) {
      case 'attack': {
        const target = String(a.args.target || '')
        if (DEADLY.has(target) && !this.cfg.allow_deadly_bosses) return { ok: false, reason: `${target}との戦闘は安全設定で禁止` }
        if (s.health < this.noCombatHealth) return { ok: false, reason: `体力${s.health}では戦闘禁止 (基準${this.noCombatHealth})` }
        if (s.gear.weapon < 0 && s.hostiles.filter(h => h.dist < 16).length >= 2) return { ok: false, reason: '素手で複数の敵と戦うのは危険' }
        if (s.players.some(p => p.name === target)) return { ok: false, reason: 'プレイヤーへの攻撃は禁止' }
        return { ok: true, action: a }
      }
      case 'explore': {
        const limit = this.exploreLimit(s)
        if (s.night && !this.cfg.night_explore && s.gear.weapon < 1) return { ok: false, reason: '夜に武器なしの探索は禁止。家に帰るか休むこと' }
        if (s.health < this.noCombatHealth) return { ok: false, reason: '体力が低いので遠出は禁止' }
        if (s.food < 8 && !s.foodItems.length) return { ok: false, reason: '食料がないので遠出は禁止。まず食料を確保' }
        const d = Number(a.args.distance) || 32
        if (d > limit) { a.args.distance = limit; return { ok: true, action: a, reason: `装備に合わせて距離を${limit}に制限` } }
        return { ok: true, action: a }
      }
      case 'go_to': {
        const limit = this.exploreLimit(s) * 1.5
        if (s.pos && a.args.x != null && a.args.z != null) {
          const d = Math.hypot(a.args.x - s.pos.x, a.args.z - s.pos.z)
          if (d > limit && !(s.home && Math.hypot(a.args.x - s.home.x, a.args.z - s.home.z) < 16)) {
            return { ok: false, reason: `目的地が遠すぎる (${Math.round(d)}m > ${Math.round(limit)}m)` }
          }
        }
        return { ok: true, action: a }
      }
      case 'eat': {
        if (!s.foodItems.length) return { ok: false, reason: '食べ物を持っていない。動物を倒す(attack)・釣り(fish)・畑(plant_and_harvest)で手に入れること' }
        if (s.food >= 20) return { ok: false, reason: 'お腹はいっぱい' }
        return { ok: true, action: a }
      }
      case 'build_house': {
        const mats = s.inventory.filter(i => /(_planks|cobblestone|^stone$|bricks|^dirt$|sandstone|deepslate)/.test(i.name)).reduce((n, i) => n + i.count, 0)
        if (mats < 20) return { ok: false, reason: `建材が足りない (${mats}個)。先に collect で木(log)を集めて craft で板材にするか、石(stone)を集めること` }
        return { ok: true, action: a }
      }
      case 'collect': {
        if (s.health < 6) return { ok: false, reason: '体力が低すぎる' }
        const n = Math.min(16, Math.max(1, Number(a.args.count) || 4)) // 1回の行動は短く
        a.args.count = n
        if (/lava|bedrock|spawner/.test(String(a.args.block))) return { ok: false, reason: '危険・不可能なブロック' }
        return { ok: true, action: a }
      }
      default:
        return { ok: true, action: a }
    }
  }

  // 死因から「次に活かす教訓」とプログラム側のルール変更を作る
  static lessonFromDeath (cause = '') {
    const c = cause.toLowerCase()
    if (/lava|溶岩/.test(c)) return '溶岩の近くでは足元を確認し、地下を掘り進むときは慎重に'
    if (/fell|落下|high place|hit the ground/.test(c)) return '高い所では端に近づかない。降りるときは階段状に'
    if (/drown|溺/.test(c)) return '水中に長くいない。息が続くうちに上がる'
    if (/creeper|blew up|爆発/.test(c)) return 'クリーパーを見たら距離を取る'
    if (/starv|餓死/.test(c)) return '遠出の前に必ず食料を持つ'
    if (/zombie|skeleton|spider|slain|shot|ゾンビ|スケルトン|クモ/.test(c)) return '夜や暗い場所では敵が多い。体力が減ったら早めに帰る'
    return '危ない場所では無理をせず、早めに引き返す'
  }
}
