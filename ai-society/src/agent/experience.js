// 住人の「経験」: 自分が死んだ場所・危なかった場所・資源を見つけた場所・迷子になったこと・
// 仲間が倒れるのを見た回数などを覚えておき、次の行動 (ルールで動く体) と考え (AIに渡す文) の両方に反映する。
// 「生きているように」見せるための土台。死ぬだけでなく、いろいろな出来事を覚えて行動が変わる。
import { relativePlace } from './perception.js'

const KEEP_MS = 3 * 60 * 60000 // 3時間 (ゲームで約9日) より古い出来事は忘れる
const RECENT_MS = 40 * 60000 // 「最近」= ゲームで約2日
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const normOre = w => { const n = String(w || '').replace('deepslate_', ''); return n === 'coal' ? 'coal_ore' : n === 'iron' ? 'iron_ore' : n }
const DIR_JA = { north: '北', south: '南', east: '東', west: '西' }

export class Experience {
  constructor (agent) {
    this.agent = agent
    this.key = `exp:${agent.name}`
    const d = agent.store.getState(this.key, null) || {}
    this.events = Array.isArray(d.events) ? d.events : []
    this._forget()
  }

  _forget () {
    const now = Date.now()
    this.events = this.events.filter(e => now - e.t < KEEP_MS).slice(-120)
  }

  _save () { this._forget(); this.agent.store.setState(this.key, { events: this.events }) }

  _pos (p) { return p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null }

  // 出来事を1つ覚える。kind: died / saw_death / heard_scream / hurt / lost / found / rescued
  add (kind, data = {}) {
    const e = { kind, t: Date.now(), day: this.agent.day?.() ?? null, ...data }
    if (e.pos) e.pos = this._pos(e.pos)
    this.events.push(e)
    this._save()
    return e
  }

  recent (kind, ms = RECENT_MS, filter = () => true) {
    const now = Date.now()
    return this.events.filter(e => e.kind === kind && now - e.t < ms && filter(e))
  }

  // 自分の最近の死
  myDeaths (ms = RECENT_MS) { return this.recent('died', ms) }

  // 自分が知っている (見た・悲鳴を聞いた) その人の最近の死の回数
  knownDeathsOf (name, ms = RECENT_MS) {
    return this.recent('saw_death', ms, e => e.who === name).length + this.recent('heard_scream', ms, e => e.who === name).length
  }

  // 危ない場所 (自分が死んだ・やられた・仲間が倒れるのを見た所)。新しいほど・死ぬほど重い
  dangerSpots (ms = RECENT_MS) {
    const now = Date.now()
    return this.events.filter(e => e.pos && now - e.t < ms && ['died', 'hurt', 'saw_death'].includes(e.kind))
  }

  // 探検の向きを決めるとき: 危ない場所がある向きを避ける。全部危ないならそのまま
  safeDirection (from, wanted, dist) {
    const spots = this.dangerSpots()
    if (!spots.length || !from) return { dir: wanted, avoided: null }
    const risk = dir => {
      const [dx, dz] = DIRS[dir]
      let r = 0
      for (const s of spots) {
        // その向きにまっすぐ進んだ線から、危ない場所までの近さ
        const vx = s.pos.x - from.x; const vz = s.pos.z - from.z
        const along = vx * dx + vz * dz
        if (along < -8 || along > dist + 24) continue
        const side = Math.abs(vx * dz - vz * dx)
        if (side < 24) r += s.kind === 'died' ? 3 : s.kind === 'saw_death' ? 2 : 1
      }
      return r
    }
    const order = wanted && DIRS[wanted] ? [wanted, ...Object.keys(DIRS).filter(d => d !== wanted)] : Object.keys(DIRS).sort(() => Math.random() - 0.5)
    const first = order[0]
    if (risk(first) === 0) return { dir: first, avoided: null }
    const best = order.slice().sort((a, b) => risk(a) - risk(b))[0]
    return { dir: best, avoided: best !== first ? DIR_JA[first] : null }
  }

  // 最近ひどい目にあっていたら、遠出を控える (迷子・死亡)
  exploreFactor () {
    const lost = this.recent('lost').length + this.recent('rescued').length
    const died = this.myDeaths().length
    return Math.max(0.4, 1 - lost * 0.2 - died * 0.15)
  }

  // 前にその資源を見つけた場所 (いちばん新しいもの)
  resourceSpot (what) {
    what = normOre(what)
    const f = this.events.filter(e => e.kind === 'found' && e.what === what && e.pos)
    return f.length ? f[f.length - 1].pos : null
  }

  // 資源を見つけた (同じ場所の重複は覚えない)
  found (what, pos) {
    what = normOre(what)
    const p = this._pos(pos)
    if (!p) return
    if (this.events.some(e => e.kind === 'found' && e.what === what && e.pos && Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < 16)) return
    this.add('found', { what, pos: p })
  }

  // やられた (同じ相手に何度も記録しない: 1分に1回)
  hurt (by, pos) {
    if (this.recent('hurt', 60000).length) return
    this.add('hurt', { by, pos })
  }

  _ago (t) {
    const m = Math.round((Date.now() - t) / 60000)
    return m < 1 ? 'さっき' : m < 60 ? `${m}分前` : `${Math.round(m / 60)}時間前`
  }

  _place (pos) { return relativePlace(pos, this.agent.village?.center || this.agent.home) }

  // AIに渡す「最近の経験」(考えるとき・返事のとき)。数が多いことは数で言う
  text (limit = 6) {
    const lines = []
    const dn = this.agent.society.displayName.bind(this.agent.society)
    const mine = this.myDeaths()
    if (mine.length) {
      const last = mine[mine.length - 1]
      lines.push(`- ${this._ago(last.t)}、${this._place(last.pos)}で${last.cause || '何か'}のせいで倒れた${mine.length >= 2 ? ` (最近${mine.length}回も倒れている。気をつけないと)` : ''}${last.lastWords ? ` 最期に「${last.lastWords}」と言った` : ''}`)
    }
    const seen = {}
    for (const e of [...this.recent('saw_death'), ...this.recent('heard_scream')]) (seen[e.who] = seen[e.who] || []).push(e)
    for (const [who, es] of Object.entries(seen)) {
      const last = es[es.length - 1]
      const what = last.kind === 'saw_death' ? `${dn(who)}が${last.cause || ''}で倒れるのを見た${last.lastWords ? ` (最期に「${last.lastWords}」)` : ''}` : `${dn(who)}の悲鳴を聞いた`
      lines.push(`- ${this._ago(last.t)}、${what}${es.length >= 2 ? ` — 最近${es.length}回目。${es.length >= 3 ? '死にすぎだと思う' : '多い気がする'}` : ''}`)
    }
    const hurt = this.recent('hurt')
    if (hurt.length) {
      const last = hurt[hurt.length - 1]
      lines.push(`- ${this._ago(last.t)}、${this._place(last.pos)}で${last.by}に襲われた${hurt.length >= 3 ? ` (最近${hurt.length}回)` : ''}`)
    }
    const lost = [...this.recent('lost'), ...this.recent('rescued')]
    if (lost.length) lines.push(`- 遠くへ行きすぎて家に帰れなくなった (最近${lost.length}回)。遠出はほどほどに`)
    const found = this.events.filter(e => e.kind === 'found').slice(-3)
    for (const f of found) lines.push(`- ${this._place(f.pos)}で${jaItem(f.what)}を見つけた`)
    return lines.slice(0, limit).join('\n')
  }
}

const ITEM = { iron_ore: '鉄鉱石', coal_ore: '石炭', coal: '石炭', diamond_ore: 'ダイヤ', gold_ore: '金鉱石', copper_ore: '銅鉱石', redstone_ore: 'レッドストーン', lapis_ore: 'ラピスラズリ', emerald_ore: 'エメラルド', deepslate_iron_ore: '鉄鉱石', deepslate_coal_ore: '石炭', deepslate_diamond_ore: 'ダイヤ' }
export function jaItem (n) { return ITEM[n] || n }

// 死亡メッセージ (英語) を日本語の死因に
const MOB = { zombie: 'ゾンビ', skeleton: 'スケルトン', creeper: 'クリーパー', spider: 'クモ', cave_spider: '洞窟グモ', drowned: 'ドラウンド', husk: 'ハスク', stray: 'ストレイ', witch: 'ウィッチ', enderman: 'エンダーマン', slime: 'スライム', phantom: 'ファントム', pillager: 'ピリジャー', silverfish: 'シルバーフィッシュ', zombie_villager: '村人ゾンビ', wolf: 'オオカミ', bee: 'ハチ', iron_golem: 'アイアンゴーレム' }
export function causeJa (msg = '') {
  const m = String(msg)
  const by = m.match(/by (?:a |an )?([A-Za-z_ ]+?)(?: using.*)?$/)
  const mob = by ? (MOB[by[1].trim().toLowerCase().replace(/ /g, '_')] || by[1].trim()) : null
  if (/blown up|blew up/.test(m)) return mob ? `${mob}の爆発` : '爆発'
  if (/was shot/.test(m)) return mob ? `${mob}の矢` : '矢'
  if (/slain|killed/.test(m)) return mob ? `${mob}の攻撃` : '攻撃'
  if (/drowned/.test(m)) return 'おぼれたこと'
  if (/lava/.test(m)) return '溶岩'
  if (/burn|flames|fire/.test(m)) return '火'
  if (/fell|hit the ground|kinetic/.test(m)) return '落下'
  if (/starved/.test(m)) return '空腹'
  if (/suffocated|squashed/.test(m)) return '窒息'
  if (/froze/.test(m)) return '凍え'
  if (/pricked|walked into/.test(m)) return 'サボテンやトゲ'
  if (/floor was lava/.test(m)) return 'マグマブロック'
  return m ? '何か' : '不明な原因'
}
