// プレイヤー(人間)の発言 → 誰が・どんな態度で・どの順に返事するかを決める「進行役」。
// 文字チャットでもマイク音声でも同じ入口 (handleHuman) を通る。
//
// 1. 名指し判定: 名前/あだ名 → その人が優先。「みんな」「全員」→ 全員が聞く
// 2. 聞こえた人は全員、その発言を自分の記憶に残す (後日その話題を持ち出せる)
// 3. 返事する人を決める
//    - 名指しのみ: 名指しされた人 + たまに口を挟む人 (LLMなし・即決)
//    - みんな / 名指しなし: 進行役LLMが「公開プロフィールだけ」を見て 0〜N人と態度(賛成/反対/面倒/質問…)を選ぶ
//      (進行役には各自の個人的な記憶は渡さない → 記憶は混ざらない)
// 4. 選ばれた人が順番に、自分の人格・記憶・それまでの会話を踏まえて返事する
//    返事の中で他の住人に話を振る (ask) と、その人も続けて答える
import { findAddressed, normName } from './conversation.js'
import { Relationships } from './relationships.js'
import { PRIORITY } from '../llm/client.js'
import { log } from '../util/log.js'

export const GROUP_WORDS = /(みんな|皆さん|みなさん|皆|全員|おーい|誰か|だれか|everyone)/i

export function buildDirectorPrompt ({ playerDisplay, text, candidates, max, isGroup }) {
  const list = candidates.map(c => `- ${c.name}(${c.display}): ${c.brief} / 社交性${c.sociability} / ${playerDisplay}への気持ち: ${c.feeling} / 今: ${c.doing} / 距離${c.dist}`).join('\n')
  return [
    {
      role: 'system',
      content: `あなたはMinecraftの村で、住人たちが${playerDisplay}の発言にどう反応するかを決める進行役。
全員が機械的に返事をしてはいけない。性格・社交性・関係に合わせて、自然に反応しそうな人だけを選ぶ。
${isGroup ? `全員への呼びかけなので、${Math.min(max, candidates.length)}人前後が反応してよい。賛成・反対・面倒がる・質問する・他の人に意見を振る など、態度がばらけるように選ぶ。` : '名指しされていない発言なので、反応するのは0〜2人。誰も反応しなくてもよい。'}
最大${max}人。返事の順番も決める (すぐ反応しそうな人が先)。
必ず次のJSONだけで答える:
{"responders":[{"name":"住人の名前(英字)","stance":"賛成|反対|面倒|質問|心配|便乗|冗談|他人に振る","why":"そう反応する理由(20字以内)"}]}`
    },
    { role: 'user', content: `【聞いている住人】\n${list}\n\n${playerDisplay}「${text}」\n反応する人をJSONで答えて。` }
  ]
}

export class Floor {
  constructor (society) {
    this.society = society
    this.cfg = { use_director: true, group_max_responders: 4, single_max_responders: 2, interject_chance: 0.25, max_ask_chain: 2, thread_hold_sec: 20, ...(society.config.floor || {}) }
    this.recent = new Map()
    this.threadSeq = 0
    this.rng = Math.random
    this.chain = Promise.resolve() // 発言は1つずつ順番に処理 (2つの会話が混ざらないように)
  }

  aliases () {
    const out = []
    for (const c of this.society.characters.values()) out.push(c.username, c.display_name, ...(c.nicknames || []))
    return out
  }

  resolve (found) {
    const f = found.map(normName)
    const res = []
    for (const c of this.society.characters.values()) {
      if ([c.username, c.display_name, ...(c.nicknames || [])].some(n => f.includes(normName(n)))) res.push(c.username)
    }
    return res
  }

  playerPosition (name) {
    for (const a of this.society.aliveAgents()) {
      const p = a.bot?.players?.[name]?.entity?.position
      if (p) return p
    }
    return null
  }

  // 同じ発言が複数のボット経由で届くので重複を除く
  isDuplicate (from, text, now = Date.now()) {
    const key = `${from}|${text}`
    for (const [k, t] of this.recent) if (now - t > 5000) this.recent.delete(k)
    if (this.recent.has(key)) return true
    this.recent.set(key, now)
    return false
  }

  handleHuman (from, text, opts = {}) {
    text = String(text || '').trim()
    if (!text || this.isDuplicate(from, text)) return Promise.resolve(null)
    this.society.conversation.holdForHuman((this.cfg.thread_hold_sec) * 1000)
    const run = this.chain.then(() => this._handle(from, text, opts))
    this.chain = run.catch(() => {})
    return run
  }

  async _handle (from, text, { source = 'chat' } = {}) {
    const soc = this.society
    const agents = soc.aliveAgents().filter(a => a.ready())
    if (!agents.length) return null
    const isGroup = GROUP_WORDS.test(text)
    const addressed = this.resolve(findAddressed(text, this.aliases())).filter(n => agents.some(a => a.name === n))
    const range = soc.config.conversation?.hearing_range ?? 32
    const ppos = this.playerPosition(from)
    // 誰に聞こえたか: 「みんな」なら全員、名指しされた人は遠くても、それ以外は近くの人だけ。
    // プレイヤーがワールドにいない(位置不明)なら全員に聞こえる扱い
    const listeners = agents.filter(a => isGroup || addressed.includes(a.name) || !ppos || !a.bot?.entity || a.bot.entity.position.distanceTo(ppos) <= range)
    const thread = { id: ++this.threadSeq, from, fromDisplay: soc.displayName(from), text, source, isGroup, lines: [{ who: from, display: soc.displayName(from), text }] }
    log.info('floor', `${source === 'voice' ? '🎤' : '⌨'} ${thread.fromDisplay}「${text}」 名指し:[${addressed.join(',')}]${isGroup ? ' 全員へ' : ''} 聞こえた:${listeners.length}人`)
    soc.conversation.holdForHuman((this.cfg.thread_hold_sec) * 1000)
    for (const a of listeners) a.hearHuman(from, text, { toMe: addressed.includes(a.name), isGroup, source })
    if (!listeners.length) return { thread, plan: [] }

    const plan = await this.choose({ from, text, listeners, addressed, isGroup })
    log.info('floor', `返事する人: ${plan.map(p => `${soc.displayName(p.name)}(${p.stance || '-'})`).join(' → ') || 'なし'}`)
    const done = new Set()
    let asks = 0
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]
      const agent = soc.agents.get(p.name)
      if (!agent || done.has(p.name) || !agent.alive) continue
      done.add(p.name)
      let res = null
      try {
        res = await agent.respondInThread(thread, { stance: p.stance, why: p.why, addressed: addressed.includes(agent.name) || p.asked, isGroup })
      } catch (e) { log.warn(agent.name, '返事に失敗: ' + e.message) }
      if (res?.say) thread.lines.push({ who: agent.name, display: agent.display, text: res.say })
      // 他の住人に話を振ったら、その人も答える (連鎖は最大 max_ask_chain 回)
      const asked = res?.ask ? this.resolve([res.ask])[0] || (soc.agents.has(res.ask) ? res.ask : null) : null
      if (asked && asked !== agent.name && !done.has(asked) && asks < this.cfg.max_ask_chain && soc.agents.get(asked)?.ready()) {
        asks++
        plan.splice(i + 1, 0, { name: asked, stance: '話を振られた', why: `${agent.display}に聞かれた`, asked: true })
      }
    }
    soc.conversation.holdForHuman(3000) // 少し間を置いてから通常の雑談に戻る
    return { thread, plan }
  }

  async choose ({ from, text, listeners, addressed, isGroup }) {
    const soc = this.society
    const byName = new Map(listeners.map(a => [a.name, a]))
    const plan = []
    // 名指しされた人は必ず先頭
    for (const n of addressed) if (byName.has(n)) plan.push({ name: n, stance: null, why: '名前を呼ばれた' })
    const others = listeners.filter(a => !addressed.includes(a.name))

    if (addressed.length && !isGroup) {
      // 名指しのみ: LLMを使わず即決。社交的な人ほど、たまに口を挟む
      const max = this.cfg.single_max_responders
      const extra = others
        .filter(a => this.rng() < this.cfg.interject_chance * (0.5 + (a.character.sociability ?? 0.5)))
        .slice(0, Math.max(0, max - plan.length))
      for (const a of extra) plan.push({ name: a.name, stance: '割り込み', why: '気になって口を挟む' })
      return plan
    }

    const max = isGroup ? this.cfg.group_max_responders : this.cfg.single_max_responders
    if (this.cfg.use_director && others.length > 1) {
      try {
        const candidates = others.map(a => this.candidateInfo(a, from))
        const r = await soc.llm.requestJson(buildDirectorPrompt({ playerDisplay: soc.displayName(from), text, candidates, max, isGroup }), { priority: PRIORITY.CHAT, tag: 'floor:director', temperature: 0.9, model: this.cfg.director_model || undefined })
        for (const x of r.responders || []) {
          const name = byName.has(x.name) ? x.name : this.resolve([x.name])[0]
          if (name && byName.has(name) && !plan.some(p => p.name === name) && plan.length < max + addressed.length) plan.push({ name, stance: x.stance || null, why: x.why || '' })
        }
        return plan
      } catch (e) {
        log.warn('floor', '進行役LLMが失敗したので簡易ルールで選ぶ: ' + e.message)
      }
    }
    // 簡易ルール: 社交性で重み付けした抽選
    const pool = others.map(a => ({ a, w: (a.character.sociability ?? 0.5) * (0.5 + this.rng()) })).sort((x, y) => y.w - x.w)
    const n = isGroup ? Math.min(max, Math.max(1, Math.round(pool.length * 0.5))) : (pool.length && pool[0].w > 0.45 ? 1 : 0)
    for (const { a } of pool.slice(0, n)) plan.push({ name: a.name, stance: null, why: '' })
    return plan
  }

  candidateInfo (a, from) {
    const soc = this.society
    const rel = soc.relations.get(a.name, from)
    const ppos = this.playerPosition(from)
    const dist = ppos && a.bot?.entity ? `${Math.round(a.bot.entity.position.distanceTo(ppos))}m` : '不明'
    const row = soc.store.getAgent(a.name)
    return {
      name: a.name,
      display: a.display,
      brief: String(a.character.personality || '').split('。')[0],
      sociability: a.character.sociability ?? 0.5,
      feeling: Relationships.feeling(rel),
      doing: a.currentAction?.name ? `${a.currentAction.name}中` : (row?.current_goal || '特になし'),
      dist
    }
  }
}
