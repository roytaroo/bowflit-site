// 1人分の記憶。必ず自分の agent 名でしか読み書きしない (人格・記憶の混同防止)。
// 想起は「重要度 + 新しさ + 今の状況との文字の重なり」で順位付けする。
// 埋め込みモデル不要の軽量方式 (日本語は文字2-gramで比較)。

export function bigrams (text) {
  const s = String(text || '').toLowerCase().replace(/[\s、。！？!?,.「」『』()（）:：]/g, '')
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

function overlap (a, b) {
  if (!a.size || !b.size) return 0
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n / Math.sqrt(a.size * b.size)
}

export class AgentMemory {
  constructor (store, agentName, opts = {}) {
    this.store = store
    this.agent = agentName
    this.maxActive = opts.maxActive ?? 400
    this.consolidateBatch = opts.consolidateBatch ?? 40
  }

  add (kind, content, { importance = 3, about = null, day = null } = {}) {
    const imp = Math.max(1, Math.min(10, Math.round(importance)))
    this.store.run(
      'INSERT INTO memories (agent, kind, content, importance, about, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      this.agent, kind, String(content).slice(0, 1000), imp, about, day, Date.now()
    )
  }

  recent (limit = 10, kinds = null) {
    if (kinds) {
      const ph = kinds.map(() => '?').join(',')
      return this.store.all(`SELECT * FROM memories WHERE agent = ? AND archived = 0 AND kind IN (${ph}) ORDER BY id DESC LIMIT ?`, this.agent, ...kinds, limit).reverse()
    }
    return this.store.all('SELECT * FROM memories WHERE agent = ? AND archived = 0 ORDER BY id DESC LIMIT ?', this.agent, limit).reverse()
  }

  // 状況テキストに関連する記憶を返す
  recall (query, limit = 6, { excludeIds = [] } = {}) {
    const rows = this.store.all('SELECT * FROM memories WHERE agent = ? AND archived = 0 ORDER BY id DESC LIMIT 600', this.agent)
    if (!rows.length) return []
    const q = bigrams(query)
    const newest = rows[0].created_at
    const oldest = rows[rows.length - 1].created_at
    const span = Math.max(1, newest - oldest)
    const exclude = new Set(excludeIds)
    return rows
      .filter(r => !exclude.has(r.id))
      .map(r => {
        const recency = (r.created_at - oldest) / span // 0..1
        const rel = overlap(q, bigrams(r.content + ' ' + (r.about || '')))
        const score = r.importance / 10 * 1.0 + recency * 0.6 + rel * 1.6 + (r.kind === 'lesson' ? 0.4 : 0)
        return { ...r, score }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  about (other, limit = 5) {
    return this.store.all('SELECT * FROM memories WHERE agent = ? AND about = ? AND archived = 0 ORDER BY importance DESC, id DESC LIMIT ?', this.agent, other, limit)
  }

  lessons (limit = 5) {
    return this.store.all("SELECT * FROM memories WHERE agent = ? AND kind = 'lesson' AND archived = 0 ORDER BY importance DESC, id DESC LIMIT ?", this.agent, limit)
  }

  countActive () {
    return this.store.get('SELECT COUNT(*) AS n FROM memories WHERE agent = ? AND archived = 0', this.agent).n
  }

  // 記憶の整理: 古くて重要度の低い記憶をまとめて1件の要約にする。
  // summarizer(texts) => Promise<string>  (LLMを使う。無ければ機械的に圧縮)
  async consolidate (summarizer) {
    if (this.countActive() <= this.maxActive) return null
    const rows = this.store.all(
      "SELECT * FROM memories WHERE agent = ? AND archived = 0 AND importance <= 5 AND kind NOT IN ('lesson','summary','death') ORDER BY id ASC LIMIT ?",
      this.agent, this.consolidateBatch
    )
    if (rows.length < 5) return null
    const texts = rows.map(r => `[${r.kind}${r.day != null ? ` 日${r.day}` : ''}] ${r.content}`)
    let summary
    try {
      summary = summarizer ? await summarizer(texts) : null
    } catch { summary = null }
    if (!summary) summary = '昔の出来事のまとめ: ' + texts.map(t => t.slice(0, 40)).join(' / ').slice(0, 900)
    const ids = rows.map(r => r.id)
    this.store.run(`UPDATE memories SET archived = 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    const firstDay = rows.find(r => r.day != null)?.day ?? null
    this.add('summary', summary, { importance: 5, day: firstDay })
    return summary
  }
}

// 共有記憶 (全員の歴史)
export class SharedMemory {
  constructor (store) { this.store = store }

  add (kind, content, { importance = 5, participants = [], day = null } = {}) {
    this.store.run('INSERT INTO shared_events (kind, content, importance, participants, day, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      kind, content, importance, JSON.stringify(participants), day, Date.now())
  }

  recent (limit = 5) {
    return this.store.all('SELECT * FROM shared_events ORDER BY id DESC LIMIT ?', limit).reverse()
  }

  important (limit = 5) {
    return this.store.all('SELECT * FROM shared_events ORDER BY importance DESC, id DESC LIMIT ?', limit)
  }
}
