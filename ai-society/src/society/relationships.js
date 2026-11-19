// 人間関係。数値 (affinity/trust) は補助で、プロンプトには
// 「関係ラベル + 言葉の印象 + 根拠となった実際の出来事」を優先して渡す。
// 関係は片方向 (AがBをどう思うか と BがAをどう思うか は別)。

const clamp = v => Math.max(-100, Math.min(100, Math.round(v)))

// 出来事の種類ごとの標準的な変化量 (LLMが判定した出来事にも使う)
export const EVENT_EFFECTS = {
  helped: { affinity: 6, trust: 8 },        // 助けてもらった
  saved_life: { affinity: 15, trust: 20 },  // 命を救われた
  gift: { affinity: 8, trust: 3 },          // プレゼントをもらった
  adventure_together: { affinity: 5, trust: 4 },
  good_talk: { affinity: 2, trust: 1 },
  promise_kept: { affinity: 3, trust: 8 },
  promise_broken: { affinity: -6, trust: -15 },
  insulted: { affinity: -10, trust: -3 },
  quarrel: { affinity: -12, trust: -5 },
  apology: { affinity: 6, trust: 4 },
  reconciled: { affinity: 10, trust: 6 },
  mediated: { affinity: 4, trust: 5 },      // 仲裁してもらった
  competition_lost: { affinity: -2, trust: 0 },
  competition_won: { affinity: 1, trust: 0 },
  ignored: { affinity: -2, trust: -1 },
  died: { affinity: 0, trust: 0 }
}

export class Relationships {
  constructor (store) { this.store = store }

  init (agent, other, { label = null, affinity = 0, trust = 0, impression = '' } = {}) {
    const row = this.get(agent, other)
    if (row) return row
    this.store.run('INSERT INTO relationships (agent, other, label, affinity, trust, impression, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      agent, other, label, clamp(affinity), clamp(trust), impression, Date.now())
    return this.get(agent, other)
  }

  get (agent, other) {
    return this.store.get('SELECT * FROM relationships WHERE agent = ? AND other = ?', agent, other)
  }

  all (agent) {
    return this.store.all('SELECT * FROM relationships WHERE agent = ? ORDER BY ABS(affinity) + ABS(trust) DESC', agent)
  }

  // 実際の出来事を記録し、それに基づいて関係を動かす
  record (agent, other, eventText, type = null, { day = null, scale = 1 } = {}) {
    if (agent === other) return null
    this.init(agent, other)
    const eff = EVENT_EFFECTS[type] || { affinity: 0, trust: 0 }
    const da = Math.round(eff.affinity * scale)
    const dt = Math.round(eff.trust * scale)
    this.store.run('INSERT INTO relationship_events (agent, other, event, d_affinity, d_trust, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      agent, other, eventText, da, dt, day, Date.now())
    const r = this.get(agent, other)
    this.store.run('UPDATE relationships SET affinity = ?, trust = ?, updated_at = ? WHERE agent = ? AND other = ?',
      clamp(r.affinity + da), clamp(r.trust + dt), Date.now(), agent, other)
    return this.get(agent, other)
  }

  // 日記の振り返り時など、LLMが言葉で書き直した印象・ラベルを保存
  setImpression (agent, other, impression, label = undefined) {
    this.init(agent, other)
    if (label !== undefined && label !== null) {
      this.store.run('UPDATE relationships SET impression = ?, label = ?, updated_at = ? WHERE agent = ? AND other = ?', impression, label, Date.now(), agent, other)
    } else {
      this.store.run('UPDATE relationships SET impression = ?, updated_at = ? WHERE agent = ? AND other = ?', impression, Date.now(), agent, other)
    }
  }

  events (agent, other, limit = 3) {
    return this.store.all('SELECT * FROM relationship_events WHERE agent = ? AND other = ? ORDER BY id DESC LIMIT ?', agent, other, limit).reverse()
  }

  // 数値を曖昧な言葉に変換 (LLMに数値をそのまま見せないため)
  static feeling (r) {
    if (!r) return '特に印象なし'
    const a = r.affinity; const t = r.trust
    const like = a >= 60 ? '大好き' : a >= 25 ? '好き' : a > -15 ? '普通' : a > -50 ? '苦手' : '嫌い'
    const tr = t >= 50 ? '強く信頼' : t >= 15 ? '信頼' : t > -15 ? 'まだ様子見' : '信用していない'
    return `${like}・${tr}`
  }

  // プロンプト用の要約 (相手ごと1-2行)
  describe (agent, others = null, { withEvents = true } = {}) {
    const rows = this.all(agent).filter(r => !others || others.includes(r.other))
    return rows.map(r => {
      let s = `- ${r.other}: ${r.label ? `[${r.label}] ` : ''}${Relationships.feeling(r)}`
      if (r.impression) s += `。印象「${r.impression}」`
      if (withEvents) {
        const ev = this.events(agent, r.other, 2)
        if (ev.length) s += `。最近: ${ev.map(e => e.event).join(' / ')}`
      }
      return s
    }).join('\n')
  }

  // よく一緒にいる相手 (好意上位)
  favorite (agent) {
    return this.store.get('SELECT * FROM relationships WHERE agent = ? ORDER BY affinity + trust DESC LIMIT 1', agent)
  }
}
