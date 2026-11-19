// 9人が共有する「社会」: DB・共有記憶・人間関係・会話管理・音声・計画(プロジェクト)・死亡処理。
import { SharedMemory } from '../memory/memory.js'
import { Relationships } from './relationships.js'
import { ConversationManager, SocietyBus } from './conversation.js'
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
  async onAgentDeath (dead, { cause, pos, day, permanent }) {
    const deadName = this.displayName(dead)
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
