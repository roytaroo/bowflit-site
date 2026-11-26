// 9人が共有する「社会」: DB・共有記憶・人間関係・会話管理・音声・計画(プロジェクト)・死亡処理。
import { SharedMemory } from '../memory/memory.js'
import { Relationships } from './relationships.js'
import { ConversationManager, SocietyBus, normName } from './conversation.js'
import { Floor } from './floor.js'
import { log } from '../util/log.js'

export class Society {
  constructor ({ store, llm, config, voice = null }) {
    this.store = store
    this.llm = llm
    this.config = config
    this.voice = voice
    this.shared = new SharedMemory(store)
    this.relations = new Relationships(store)
    this.conversation = new ConversationManager(config.conversation || {})
    this.bus = new SocietyBus()
    this.agents = new Map() // username -> Agent
    this.characters = new Map()
    this.pairDaily = new Map()
    this.floor = new Floor(this)
    this.lines = [] // 最近の住人の発言 (オウム返し防止)
  }

  noteLine (from, text, now = Date.now()) {
    this.lines = this.lines.filter(l => now - l.t < 300000)
    this.lines.push({ from, text, t: now })
  }

  // 5分以内に他の住人が言ったこととほぼ同じなら、その発言を返す
  similarRecentLine (text, from, now = Date.now()) {
    if (String(text).length < 8) return null // 「了解！」のような短い相づちはかぶってもよい
    for (const l of this.lines) {
      if (l.from === from || now - l.t > 300000) continue
      if (similarity(l.text, text) >= 0.6) return l
    }
    return null
  }

  register (agent) {
    this.agents.set(agent.name, agent)
    this.characters.set(agent.name, agent.character)
  }

  names () { return [...this.characters.keys()] }

  displayName (username) {
    const p = this.config.player
    if (p && username === p.name && p.display_name) return p.display_name
    return this.characters.get(username)?.display_name || username
  }

  isAgent (username) { return this.characters.has(username) }

  // 「だいき」「ずんだもん」「メタン」などの呼び方から、Minecraft上の名前を引く
  resolveName (raw) {
    const n = normName(raw)
    if (!n) return null
    const p = this.config.player
    if (p && [p.name, p.display_name, p.gamertag].filter(Boolean).some(x => normName(x) === n)) return p.name
    for (const c of this.characters.values()) {
      if ([c.username, c.display_name, ...(c.nicknames || [])].some(x => normName(x) === n)) return c.username
    }
    return null
  }

  aliveAgents () { return [...this.agents.values()].filter(a => a.alive) }

  // 初期の人間関係を設定 (2回目以降の起動ではDBの値を優先して上書きしない)
  seedRelationships (characters) {
    for (const c of characters) {
      for (const o of characters) {
        if (c.username === o.username) continue
        const seed = c.relationships?.[o.username] || {}
        this.relations.init(c.username, o.username, seed)
      }
    }
  }

  // キャラ設定を書き直したとき (profile_version が上がったとき)、保存済みのデータを新しい設定に合わせる:
  // 長期の夢・関係の初期値を新しい設定にし、古い口調で自分が言ったセリフの記憶を消す (古い口調に引っ張られないように)
  applyProfileUpgrades (characters) {
    for (const c of characters) {
      if (!c.profile_version) continue
      const key = `profile_version:${c.username}`
      if (this.store.getState(key, 0) >= c.profile_version) continue
      this.store.ensureAgent(c.username, { long_goal: c.dream })
      this.store.updateAgent(c.username, { long_goal: c.dream, current_goal: c.personal_goal || null })
      for (const [other, seed] of Object.entries(c.relationships || {})) {
        this.relations.init(c.username, other, seed)
        this.store.run('UPDATE relationships SET label = ?, affinity = ?, trust = ?, impression = ? WHERE agent = ? AND other = ?',
          seed.label ?? null, seed.affinity ?? 0, seed.trust ?? 0, seed.impression ?? '', c.username, other)
      }
      const rows = this.store.all("SELECT id, content FROM memories WHERE agent = ? AND kind = 'chat'", c.username)
      const own = rows.filter(r => /^([^「が\s]{0,12}に)?「/.test(r.content) && /」と言った$/.test(r.content))
      for (const r of own) this.store.run('DELETE FROM memories WHERE id = ?', r.id)
      this.store.setState(key, c.profile_version)
      log.info('society', `${c.display_name}: キャラ設定を新しくした (古い口調のセリフの記憶 ${own.length}件を整理)`)
    }
  }

  // 1日1回だけ「一緒に活動した」を記録 (同じ2人で数値が急に上がらないように)
  noteTogether (a, b, what, day) {
    const key = `${[a, b].sort().join('|')}|${day}`
    if (this.pairDaily.has(key)) return
    this.pairDaily.set(key, true)
    this.relations.record(a, b, `${this.displayName(b)}と一緒に${what}`, 'adventure_together', { day, scale: 0.6 })
    this.relations.record(b, a, `${this.displayName(a)}と一緒に${what}`, 'adventure_together', { day, scale: 0.6 })
  }

  // ---- 計画 (共同建築・遠征・祭り・墓など) ----
  proposeProject (by, kind, title, detail, target = null) {
    const dup = this.store.get("SELECT id FROM projects WHERE title = ? AND status IN ('open','doing')", title)
    if (dup) return dup.id
    const day = this.agents.get(by)?.day() ?? null
    const r = this.store.run('INSERT INTO projects (kind, title, detail, proposed_by, members, target, day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      kind, title, detail, by, JSON.stringify([by]), target ? JSON.stringify(target) : null, day, Date.now(), Date.now())
    const id = Number(r.lastInsertRowid)
    this.shared.add('project', `${this.displayName(by)}が計画「${title}」を提案した: ${detail}`, { importance: 5, participants: [by], day })
    this.bus.emit('project', { id, by, kind, title, detail })
    return id
  }

  joinProject (name, id) {
    const p = this.store.get('SELECT * FROM projects WHERE id = ?', id)
    if (!p) return `計画#${id}は存在しない`
    const members = JSON.parse(p.members || '[]')
    if (!members.includes(name)) members.push(name)
    this.store.run("UPDATE projects SET members = ?, status = CASE WHEN status = 'open' THEN 'doing' ELSE status END, updated_at = ? WHERE id = ?", JSON.stringify(members), Date.now(), id)
    if (p.proposed_by && p.proposed_by !== name) {
      this.relations.record(p.proposed_by, name, `${this.displayName(name)}が自分の計画「${p.title}」に参加してくれた`, 'helped', { scale: 0.5 })
    }
    return `計画「${p.title}」に参加した`
  }

  openProjects () {
    return this.store.all("SELECT * FROM projects WHERE status IN ('open','doing') ORDER BY id DESC LIMIT 6")
  }

  describeProjects () {
    return this.openProjects().map(p => {
      const m = JSON.parse(p.members || '[]').map(n => this.displayName(n)).join('、')
      return `- #${p.id} [${p.kind}] ${p.title}: ${p.detail || ''} (提案:${this.displayName(p.proposed_by)} 参加:${m})`
    }).join('\n')
  }

  // ---- 死亡 ----
  // 誰が死に気づくか: 見える距離 (16ブロック) にいた人は「見た」、悲鳴が届く距離 (36ブロック) の人は「聞いた」。
  // それより遠い人は知らない (あとで誰かから聞くまで)
  witnesses (dead, pos) {
    const see = this.config.conversation?.hearing_range ?? 16
    const hear = this.config.conversation?.shout_range ?? 36
    const out = []
    for (const a of this.aliveAgents()) {
      if (a.name === dead) continue
      const p = a.bot?.entity?.position
      if (!pos || !p) continue
      const d = p.distanceTo(pos)
      if (d <= see) out.push({ agent: a, how: 'saw' })
      else if (d <= hear) out.push({ agent: a, how: 'heard' })
    }
    return out
  }

  async onAgentDeath (dead, { cause, pos, day, permanent }) {
    const deadName = this.displayName(dead)
    const known = this.witnesses(dead, pos)
    if (!permanent && !this.config.death?.react_on_respawn) {
      if (known.length) log.info('society', `${deadName}が倒れたのに気づいた: ${known.map(k => `${k.agent.display}(${k.how === 'saw' ? '見た' : '悲鳴'})`).join(', ')}`)
      await Promise.allSettled(known.map(k => k.agent.reactToDeath(dead, { cause, pos, day, permanent, how: k.how })))
      return
    }
    this.shared.add('death', `${deadName}が${cause}で${permanent ? '亡くなった' : '死んでしまった'}${pos ? ` (場所 ${pos.x},${pos.y},${pos.z})` : ''}`, { importance: permanent ? 10 : 7, participants: [dead], day })
    const others = this.aliveAgents().filter(a => a.name !== dead)
    let graveWanted = permanent && this.config.death?.grave_on_permanent_death !== false
    // 全員が順番に反応する (LLMキューで直列化される)。反応は人それぞれ。
    const results = await Promise.allSettled(others.map(a => a.reactToDeath(dead, { cause, pos, day, permanent })))
    for (const r of results) if (r.status === 'fulfilled' && r.value?.propose_grave) graveWanted = true
    if (this.config.death?.grave_mode === 'never') graveWanted = false
    if (graveWanted) {
      const proposer = results.findIndex(r => r.status === 'fulfilled' && r.value?.propose_grave)
      const by = proposer >= 0 ? others[proposer].name : (others[0]?.name || dead)
      this.proposeProject(by, 'grave', `${deadName}のお墓`, `${deadName}を偲んでお墓を建てる (build_grave で for=${dead})`, { for: dead })
    }
    log.info('society', `${deadName}の死亡を全員に通知 (墓の提案: ${graveWanted ? 'あり' : 'なし'})`)
  }

  recordDiscovery (name, pos) {
    const day = this.agents.get(name)?.day() ?? null
    const key = `discover:${Math.round(pos.x / 64)}:${Math.round(pos.z / 64)}`
    if (this.store.getState(key)) return
    this.store.setState(key, { by: name, day })
    this.shared.add('discovery', `${this.displayName(name)}が新しい土地(${Math.round(pos.x)},${Math.round(pos.z)}付近)を発見した`, { importance: 4, participants: [name], day })
  }
}

// 2つの文の似ている度合い (0〜1): 2文字ずつの組の重なり
export function similarity (a, b) {
  const norm = t => String(t || '').replace(/[\s、。！？!?…ー〜「」]/g, '')
  const grams = t => { const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g }
  const A = grams(norm(a)); const B = grams(norm(b))
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / Math.min(A.size, B.size)
}

