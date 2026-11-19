// 会話の交通整理。
// - AI同士の会話が無限に続かないよう、ペアごとの往復回数と全体の発言頻度に上限を設ける
// - 名指しされていない発言には、1つの発言につき最大1人だけが反応する (全員が一斉に返事しない)
// - ゲーム内チャットへの表示とは別に、プロセス内のイベントバスで確実に届ける
import { EventEmitter } from 'node:events'

export class SocietyBus extends EventEmitter {
  constructor () { super(); this.setMaxListeners(50) }
}

export class ConversationManager {
  constructor (cfg = {}) {
    this.maxExchanges = cfg.max_bot_exchanges ?? 6     // 同じ2人の連続往復上限
    this.windowMs = (cfg.exchange_window_sec ?? 120) * 1000
    this.pairCooldownMs = (cfg.pair_cooldown_sec ?? 180) * 1000
    this.maxBotMsgsPerMin = cfg.max_bot_messages_per_min ?? 14
    this.hearingRange = cfg.hearing_range ?? 32
    this.pairs = new Map()     // key -> { times: [], cooldownUntil }
    this.recentBotMsgs = []
    this.claims = new Map()    // msgId -> agent
    this.msgSeq = 0
    this.humanHoldUntil = 0   // プレイヤーとの会話中は、AI同士の自動返事を止める (進行役が順番を管理)
  }

  holdForHuman (ms, now = Date.now()) { this.humanHoldUntil = Math.max(this.humanHoldUntil, now + ms) }
  humanThreadActive (now = Date.now()) { return now < this.humanHoldUntil }

  newMessageId () { return ++this.msgSeq }

  _pair (a, b) {
    const key = [a, b].sort().join('|')
    if (!this.pairs.has(key)) this.pairs.set(key, { times: [], cooldownUntil: 0 })
    return this.pairs.get(key)
  }

  // ボットが発言した記録
  noteBotMessage (from, to = null, now = Date.now()) {
    this.recentBotMsgs = this.recentBotMsgs.filter(t => now - t < 60000)
    this.recentBotMsgs.push(now)
    if (to) {
      const p = this._pair(from, to)
      p.times = p.times.filter(t => now - t < this.windowMs)
      p.times.push(now)
      if (p.times.length >= this.maxExchanges) {
        p.cooldownUntil = now + this.pairCooldownMs
        p.times = []
      }
    }
  }

  botChatBudgetOk (now = Date.now()) {
    return this.recentBotMsgs.filter(t => now - t < 60000).length < this.maxBotMsgsPerMin
  }

  // listener が msg に返事をするべきか
  // msg: { id, from, fromIsBot, text, addressed: [names], distance }
  shouldReply (listener, msg, { sociability = 0.5, rng = Math.random, now = Date.now() } = {}) {
    if (msg.from === listener) return false
    const addressed = (msg.addressed || []).includes(listener)
    if (msg.distance != null && msg.distance > this.hearingRange && !addressed && msg.fromIsBot) return false
    if (msg.fromIsBot && this.humanThreadActive(now)) return false
    if (msg.fromIsBot) {
      const p = this._pair(msg.from, listener)
      if (now < p.cooldownUntil) return false
      if (!this.botChatBudgetOk(now)) return false
    }
    if (addressed) return true
    // 他の誰かが名指しされているなら割り込まない (たまに口を挟む)
    if ((msg.addressed || []).length && rng() > 0.1) return false
    if (this.claims.has(msg.id)) return false
    const base = msg.fromIsBot ? 0.35 : 0.8
    if (rng() < base * (0.5 + sociability)) {
      this.claims.set(msg.id, listener)
      if (this.claims.size > 500) this.claims.delete(this.claims.keys().next().value)
      return true
    }
    return false
  }
}

// 発言から名指しされている名前を抜き出す
export function findAddressed (text, names) {
  const t = String(text)
  return names.filter(n => t.includes(n) || t.toLowerCase().includes(n.toLowerCase()))
}

// Minecraftのチャット長制限 (256文字) に収まるよう分割
export function splitChat (text, max = 100) {
  const out = []
  let s = String(text).replace(/\s+/g, ' ').trim()
  while (s.length > max) {
    let cut = Math.max(s.lastIndexOf('。', max), s.lastIndexOf('、', max), s.lastIndexOf(' ', max))
    if (cut < max * 0.5) cut = max
    out.push(s.slice(0, cut + 1).trim())
    s = s.slice(cut + 1).trim()
  }
  if (s) out.push(s)
  return out
}
