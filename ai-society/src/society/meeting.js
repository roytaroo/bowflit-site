// 朝の会議: 朝になったら、みんなの家に集まって「今日なにする？」を住人同士で話し合う。
// 1人ずつ性格どおりに意見を言い、最後に1人1つ「今日の仕事」と「一緒にやる相手」を決める。
// 決まった仕事は dayPlan として、その日の「自分の仕事」より優先される。相手と約束したら一緒に動く。
import { personaBlock } from '../agent/prompts.js'
import { PRIORITY } from '../llm/client.js'
import { log, sleep } from '../util/log.js'

// 今日の仕事のメニュー (LLMはこの中から選ぶ。実際の動きはルールで確実に)
export const DAY_TASKS = {
  wood: { ja: '木を切って原木を集める', chore: { name: 'collect', args: { block: 'log', count: 12 } } },
  stone: { ja: '石を掘って丸石を集める', chore: { name: 'collect', args: { block: 'stone', count: 16 } } },
  coal: { ja: '石炭を探して掘る', chore: { name: 'collect', args: { block: 'coal', count: 8 } } },
  iron: { ja: '鉄を探して掘る', chore: { name: 'collect', args: { block: 'iron_ore', count: 6 } } },
  food: { ja: '動物を狩ったり魚を釣ったりして食べ物を集める', chore: { name: 'attack', args: { target: 'cow' } } },
  farm: { ja: '畑の世話をする', chore: { name: 'plant_and_harvest', args: {} } },
  explore: { ja: '遠くを探検して新しい場所を見つける', chore: { name: 'explore', args: { distance: 64 } } },
  tools: { ja: 'みんなの道具 (石のツルハシ・剣・松明) を作る', chore: { name: 'craft', args: { item: 'stone_pickaxe', count: 1 } } },
  storage: { ja: '家のチェストを整理する', chore: { name: 'store_items', args: {} } }
}

export function buildMeetingPrompt ({ character, agentRow, playerDisplay, day, others, lines, inventory, yesterday, round, final }) {
  const menu = Object.entries(DAY_TASKS).map(([k, v]) => `- ${k}: ${v.ja}`).join('\n')
  const system = personaBlock(character, agentRow, { playerDisplay, compact: true }) + `

今は${day}日目の朝。みんなの家に集まって、今日それぞれ何をするか話し合っている。
自分の性格・得意なこと・仲間との関係に合わせて、自分の口調で話す (1〜2文、60字以内)。
他の人の意見に反応してよい (賛成・反対・からかう・張り合う・誘う など)。同じ内容を繰り返さない。
今日の仕事はこのメニューから1つ選ぶ:
${menu}
誰かと一緒にやりたいなら "with" にその人の名前 (英字) を入れる。一人でやるなら null。
${final ? 'これが最後の発言。今日の仕事を決めて宣言する。' : ''}
必ず次のJSONだけで答える:
{"say":"会議での発言","task":"メニューのキー","with":null または "名前"}`
  const user = `【会議に来ている仲間】${others.join(', ')}
【自分の持ち物】${inventory || 'なし'}
${yesterday ? `【昨日の自分】${yesterday}` : ''}
【ここまでの会議の発言】
${lines.length ? lines.map(l => `- ${l}`).join('\n') : '- (まだ誰も話していない。最初に話す)'}
${round > 1 ? '\n(2回目の発言。みんなの意見を聞いて、最終的に決める)' : ''}
JSONで答えて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

export class MorningMeeting {
  constructor (society) {
    this.society = society
    this.active = false
  }

  // 今日の会議がまだで、朝なら開く
  shouldStart (agents) {
    if (this.active) return false
    const ready = agents.filter(a => a.alive && a.ready() && !a.bot.isSleeping)
    if (ready.length < 1) return false
    const t = ready[0].bot.time
    if (!t || t.timeOfDay == null) return false
    const day = t.day
    if (t.timeOfDay > 4000 || t.timeOfDay < 0) return false
    return this.society.store.getState('meeting_day', -1) !== day
  }

  async run (agents) {
    const soc = this.society
    const present = agents.filter(a => a.alive && a.ready())
    if (!present.length) return
    const day = present[0].bot.time.day
    soc.store.setState('meeting_day', day)
    this.active = true
    soc.meetingActive = true
    try {
      const village = soc.store.getState('village', null)
      log.info('meeting', `☀ ${day}日目の朝の会議 (${present.map(a => a.display).join('・')})`)
      // 家に集まる (最大60秒)
      if (village) {
        for (const a of present) { a.interruptAction?.(); a.pendingAction = { name: 'go_home', args: {}, reflex: true } }
        const until = Date.now() + 60000
        while (Date.now() < until && present.some(a => a.bot?.entity && a.bot.entity.position.distanceTo(new a.bot.entity.position.constructor(village.center.x, village.center.y, village.center.z)) > 10)) await sleep(2000)
      }
      const lines = []
      const decided = {}
      const rounds = present.length <= 4 ? 2 : 1 // 人数が多いときは1周で決める (AIの回数を節約)
      for (let round = 1; round <= rounds; round++) {
        const order = [...present].sort(() => Math.random() - 0.5)
        for (const a of order) {
          const final = round === rounds
          const r = await this._speak(a, { day, present, lines, round, final }).catch(e => { log.warn('meeting', `${a.display}: ${e.message}`); return null })
          if (!r) continue
          if (r.say) { await a.say(r.say); lines.push(`${a.display}「${r.say}」`) }
          const task = DAY_TASKS[r.task] ? r.task : (decided[a.name]?.task || null)
          const withName = r.with ? (soc.resolveName?.(String(r.with)) || String(r.with)) : null
          if (task) decided[a.name] = { task, with: withName && withName !== a.name && present.some(p => p.name === withName) ? withName : null }
          await sleep(800)
        }
      }
      // 決まらなかった人は役割に合う仕事を
      for (const a of present) if (!decided[a.name]) decided[a.name] = { task: a.character.default_task || 'wood', with: null }
      // 約束: A が B と一緒にやると言ったら、B も A と同じ仕事をする (先に言った方の仕事に合わせる)
      for (const [name, d] of Object.entries(decided)) {
        if (!d.with) continue
        const partner = decided[d.with]
        if (!partner) continue
        if (!partner.with || partner.with === name) {
          partner.task = partner.with === name ? partner.task : d.task
          partner.with = name
          d.task = partner.task
          soc.store.run('INSERT INTO promises (agent, to_agent, content, day, created_at) VALUES (?, ?, ?, ?, ?)', name, d.with, `今日は一緒に${DAY_TASKS[d.task].ja}`, day, Date.now())
        }
      }
      for (const a of present) {
        const d = decided[a.name]
        a.setDayPlan({ ...d, day })
        const partner = d.with ? `${soc.displayName(d.with)}と一緒に` : ''
        log.info('meeting', `  ${a.display}: ${partner}${DAY_TASKS[d.task].ja}`)
        a.memory.add('goal', `${day}日目の朝の会議で、今日は${partner}${DAY_TASKS[d.task].ja}ことにした`, { importance: 5, about: d.with || null, day })
      }
      soc.shared.add('meeting', `${day}日目の朝の会議: ` + present.map(a => `${a.display}は${decided[a.name].with ? soc.displayName(decided[a.name].with) + 'と' : ''}${DAY_TASKS[decided[a.name].task].ja.replace(/る$/, 'る')}`).join('、'), { importance: 4, participants: present.map(a => a.name), day })
    } finally {
      this.active = false
      soc.meetingActive = false
    }
  }

  async _speak (agent, { day, present, lines, round, final }) {
    const soc = this.society
    const inv = agent.bot.inventory.items().map(i => `${i.name}x${i.count}`).slice(0, 12).join(', ')
    const diary = soc.store.get('SELECT content FROM diaries WHERE agent = ? ORDER BY day DESC LIMIT 1', agent.name)
    const messages = buildMeetingPrompt({
      character: agent.character,
      agentRow: soc.store.getAgent(agent.name),
      playerDisplay: soc.displayName(soc.config.player?.name),
      day,
      others: present.filter(p => p !== agent).map(p => `${p.name}(${p.display})`),
      lines,
      inventory: inv,
      yesterday: diary?.content?.slice(0, 120),
      round,
      final
    })
    const r = await soc.llm.requestJson(messages, { priority: PRIORITY.URGENT, tag: `${agent.name}:meeting` })
    if (r.say) r.say = await agent._inVoice(String(r.say), messages, PRIORITY.URGENT)
    return r
  }
}
