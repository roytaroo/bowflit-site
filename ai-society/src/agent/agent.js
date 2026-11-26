// 1人のAI住人。
//  [通常のプログラム] 接続・知覚・反射行動・安全審査・行動実行・記録
//  [LLM]             行動の意思決定・目標設定・会話・日記・死への反応
import { createRequire } from 'node:module'
import { snapshot, describeState } from './perception.js'
import { Safety } from './safety.js'
import { ACTIONS } from './actions.js'
import { AgentMemory } from '../memory/memory.js'
import { Relationships } from '../society/relationships.js'
import { findAddressed, splitChat, normName } from '../society/conversation.js'
import { PRIORITY } from '../llm/client.js'
import { REQUEST_ACTIONS, buildDecidePrompt, buildReplyPrompt, buildDiaryPrompt, buildDeathReactionPrompt, buildSummarizePrompt } from './prompts.js'
import { log, sleep, withTimeout } from '../util/log.js'

const require = createRequire(import.meta.url)

const DEATH_WORDS = /(was slain|was shot|was blown up|blew up|drowned|fell|hit the ground|burned|burnt|tried to swim in lava|went up in flames|starved|suffocated|was killed|died|withered|froze|was pricked|was squashed|was impaled|experienced kinetic|discovered the floor was lava|walked into)/

export class Agent {
  constructor (character, society, opts = {}) {
    this.character = character
    this.name = character.username
    this.display = character.display_name
    this.society = society
    this.store = society.store
    this.cfg = society.config
    this.createBot = opts.createBot || null
    this.row = this.store.ensureAgent(this.name, { long_goal: character.dream })
    this.alive = !!this.row.alive
    this.home = this.row.home ? JSON.parse(this.row.home) : null
    this.bedPos = this.store.getState(`bed:${this.name}`, null) // 自分で置いたベッドの場所
    this.memory = new AgentMemory(this.store, this.name, this.cfg.memory || {})
    this.safety = new Safety(this.cfg.safety || {}, this.row)
    this.heard = []          // この人が実際に聞いた会話だけ (他人の記憶とは混ざらない)
    this.inbox = []
    this.pendingAction = null
    this.lastResult = null
    this.rejected = null
    this.busy = false
    this.interruptFlag = false
    this.running = false
    this.bot = null
    this.lastDecision = 0
    this.reconnects = 0
    this.lastDeathMsg = null
    this.lastDayObserved = null
    this.society.register(this)
  }

  day () {
    const d = this.bot?.time?.day
    if (d != null && !Number.isNaN(d)) return d
    return this.store.getState('pseudo_day', 0)
  }

  // ------------------------------------------------------------------ 接続
  async start () {
    if (!this.alive) { log.info(this.name, '永眠しているため参加しない'); return }
    this.running = true
    this._connect()
    this._decideLoop()
    this._replyLoop()
    this._idleLoop()
  }

  _connect () {
    const mc = this.cfg.minecraft
    const mineflayer = require('mineflayer')
    const make = this.createBot || mineflayer.createBot
    const bot = make({
      host: mc.host, port: mc.port, username: this.name, version: mc.version || false,
      auth: mc.auth || 'offline', checkTimeoutInterval: 60000, hideErrors: false
    })
    this.bot = bot
    const { pathfinder, Movements } = require('mineflayer-pathfinder')
    bot.loadPlugin(pathfinder)
    bot.loadPlugin(require('mineflayer-collectblock').plugin)
    bot.loadPlugin(require('mineflayer-pvp').plugin)

    bot.once('spawn', () => {
      this.reconnects = 0
      const m = new Movements(bot)
      m.allowParkour = false        // 危険なジャンプはしない
      m.allowSprinting = true
      m.canDig = false             // 掘りながら進む経路は候補が爆発的に増えてメモリを食うので使わない
      m.maxDropDown = 3             // 落下ダメージを受ける高さから降りない
      m.dontCreateFlow = true
      m.allow1by1towers = false    // 足場を積んで登る経路も同じ理由で使わない
      try {
        const md = require('minecraft-data')(bot.version)
        for (const n of ['lava', 'fire', 'magma_block', 'sweet_berry_bush', 'powder_snow', 'cactus', 'wither_rose']) {
          if (md.blocksByName[n]) m.blocksToAvoid.add(md.blocksByName[n].id)
        }
      } catch {}
      bot.pathfinder.setMovements(m)
      // 経路探索が広がりすぎてメモリを使い果たさないよう、範囲と時間を制限
      bot.pathfinder.searchRadius = this.cfg.agent?.path_search_radius ?? 40
      bot.pathfinder.thinkTimeout = 2500
      // 採掘プラグイン用: 目的のブロックは掘れるようにするが、掘りながら進むのは大きく割高にして経路探索の膨張を防ぐ
      if (bot.collectBlock) {
        const cm = new Movements(bot)
        Object.assign(cm, { allowParkour: false, allowSprinting: true, canDig: true, digCost: 40, maxDropDown: 3, dontCreateFlow: true, allow1by1towers: false })
        for (const id of m.blocksToAvoid) cm.blocksToAvoid.add(id)
        bot.collectBlock.movements = cm
      }
      // はまったとき用: 掘る・足場を積むのも許す (短い距離だけ使う)
      const esc = new Movements(bot)
      Object.assign(esc, { allowParkour: false, allowSprinting: false, canDig: true, digCost: 2, maxDropDown: 3, dontCreateFlow: true, allow1by1towers: true })
      for (const id of m.blocksToAvoid) esc.blocksToAvoid.add(id)
      bot.__escapeMovements = esc
      log.info(this.name, `${this.display} がワールドに参加 (${bot.version})`)
      this.memory.add('event', 'ワールドで目を覚ました', { importance: 2, day: this.day() })
      this._reflexTimer = setInterval(() => this._reflexTick(), 1000)
    })

    // スポーンのたび (リスポーン含む) に頭上の名前・吹き出しを付け直す
    bot.on('spawn', () => setTimeout(() => this.society.display?.attach(this.character), 1500))
    bot.on('chat', (username, message) => this._onGameChat(username, message))
    bot.on('messagestr', (msg, position) => {
      if (position === 'chat') return
      if (msg.startsWith(this.name + ' ') && DEATH_WORDS.test(msg)) this.lastDeathMsg = { msg, t: Date.now() }
    })
    bot.on('death', () => this._onDeath().catch(e => log.error(this.name, 'death処理失敗: ' + e.message)))
    bot.on('playerJoined', p => this._onPlayerJoined(p))
    bot.on('time', () => this._onTime())
    bot.on('kicked', r => log.warn(this.name, 'キックされた: ' + JSON.stringify(r).slice(0, 200)))
    bot.on('error', e => log.warn(this.name, 'エラー: ' + e.message))
    bot.on('end', reason => {
      clearInterval(this._reflexTimer)
      log.warn(this.name, `切断 (${reason})`)
      if (!this.running || !this.alive) return
      const wait = Math.min(60000, 5000 * 2 ** this.reconnects++)
      setTimeout(() => this.running && this._connect(), wait)
    })
  }

  stop () {
    this.running = false
    this.society.display?.detach(this.character)
    clearInterval(this._reflexTimer)
    try { this.bot?.quit() } catch {}
  }

  // メモリが危ないときなどに、移動・戦闘・実行中の行動をすぐ止める
  emergencyStop () {
    if (!this.bot) return
    this.interruptFlag = true
    try { this.bot.pathfinder?.stop(); this.bot.pathfinder?.setGoal(null) } catch {}
    try { this.bot.pvp?.stop() } catch {}
  }

  ready () { return !!(this.bot && this.bot.entity && this.bot.pathfinder) }

  interrupted () { return this.interruptFlag || !this.running }

  // ------------------------------------------------------------------ 反射 (LLMなし)
  _reflexTick () {
    if (!this.ready() || !this.alive) return
    const s = this.state({ scanBlocks: false }) // 毎秒なのでブロックの走査はしない
    let r = this.safety.reflex(s)
    if (!r) r = this._bedtime(s)
    if (!r) return
    if (this.currentAction?.reflex && this.currentAction.name === r.name) return
    if (this.busy) {
      log.info(this.name, `反射行動: ${r.name} (${r.reason}) → 現在の行動を中断`)
      this.interruptFlag = true
      try { this.bot.pathfinder.stop(); this.bot.pvp?.stop() } catch {}
    }
    this.pendingAction = { ...r, reflex: true }
  }

  // 夜になったら、ベッドを持っている(置いてある)住人は寝る。夜の外は危ないので LLM の判断を待たない
  _bedtime (s) {
    if (this.cfg.world?.auto_sleep === false || !s.night || this.bot.isSleeping) return null
    if (this.currentAction?.name === 'sleep' || Date.now() - (this._lastBedTry || 0) < 45000) return null
    const hasBed = s.inventory.some(i => i.name.endsWith('_bed')) || this.bedPos
    if (!hasBed || s.hostiles.some(h => h.dist <= 10) || s.inWater) return null
    this._lastBedTry = Date.now()
    return { name: 'sleep', args: {}, reason: '夜になったので寝る' }
  }

  state ({ scanBlocks = true } = {}) {
    return snapshot(this.bot, { home: this.home, knownAgents: this.society.names(), scanBlocks })
  }

  // ------------------------------------------------------------------ 考え中の動き (LLMなし)
  // AIが次の行動を考えている間・返事を考えている間に固まらないように、軽い動きをする:
  // 話しかけてきた人の方を向く・近くに寄る・きょろきょろする・少し歩く
  async _idleLoop () {
    let n = 0
    while (this.running) {
      await sleep(1200)
      try { this._idleStep(n++) } catch {}
    }
  }

  _idleStep (n) {
    const bot = this.bot
    if (!this.ready() || !this.alive || this.busy || this.pendingAction || bot.isSleeping) { this._idling = false; return }
    if (this.cfg.agent?.idle_motion === false) return
    const me = bot.entity.position
    const { goals } = require('mineflayer-pathfinder')
    // 近くの人間 (話しかけてきた人を優先)
    const humans = Object.values(bot.players).filter(p => p.entity && !this.society.isAgent(p.username))
    const talker = humans.find(p => p.username === this.lastHumanSpeaker)
    const target = talker || humans.sort((a, b) => a.entity.position.distanceTo(me) - b.entity.position.distanceTo(me))[0]
    const dist = target ? target.entity.position.distanceTo(me) : Infinity
    const recentlyTalked = this.lastHumanTalkAt && Date.now() - this.lastHumanTalkAt < 90000
    if (target && recentlyTalked && dist > 5 && dist < 28) {
      // 話しかけられたら、その人のそばへ寄っていく
      bot.pathfinder.setGoal(new goals.GoalFollow(target.entity, 3), true)
      this._idling = true
      return
    }
    if (this._idling) { try { bot.pathfinder.setGoal(null) } catch {} ; this._idling = false }
    if (target && dist < 10) { bot.lookAt(target.entity.position.offset(0, 1.6, 0)).catch(() => {}); return }
    if (n % 5 === 4 && Math.random() < 0.5) {
      // たまに少し歩く
      const a = Math.random() * Math.PI * 2
      bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(me.x + Math.cos(a) * 4), Math.floor(me.y), Math.floor(me.z + Math.sin(a) * 4), 1))
      this._idling = true
      setTimeout(() => { if (this._idling && !this.busy) { try { bot.pathfinder.setGoal(null) } catch {} ; this._idling = false } }, 4000)
      return
    }
    // きょろきょろ
    bot.look(bot.entity.yaw + (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 0.4).catch(() => {})
  }

  // ------------------------------------------------------------------ 意思決定ループ
  async _decideLoop () {
    const minGap = this.cfg.agent?.decide_interval_ms ?? 5000
    while (this.running) {
      try {
        if (!this.ready() || !this.alive) { await sleep(1000); continue }
        if (this.pendingAction) {
          const a = this.pendingAction; this.pendingAction = null
          await this._execute(a, a.reflex ? 'reflex' : 'reply')
          continue
        }
        const since = Date.now() - this.lastDecision
        if (since < minGap) { await sleep(minGap - since); continue }
        // プレイヤーへの返事を作っている間は、次の行動を考えるのを待つ (AIを返事に専念させる)
        if (this.society.floor?.busy?.()) { await sleep(500); continue }
        // LLMが混んでいるときは待つ (9人が一斉に考えて詰まらないように)
        const maxPending = this.cfg.llm?.max_pending ?? Math.max(2, this.society.aliveAgents().length)
        if (this.society.llm.pending() >= maxPending) { await sleep(800); continue }
        this.lastDecision = Date.now()
        const decision = await this._decide()
        if (!this.running) break
        if (this.pendingAction) continue // 考えている間に緊急事態
        await this._handleDecision(decision)
      } catch (e) {
        log.warn(this.name, '意思決定ループのエラー: ' + e.message)
        this.lastResult = `考えがまとまらなかった (${e.message.slice(0, 60)})`
        await sleep(3000)
      }
    }
  }

  _recentChatText (n = 6) {
    return this.heard.slice(-n).map(h => `- ${h.fromDisplay}「${h.text}」`).join('\n')
  }

  async _decide () {
    const s = this.state()
    const stateText = describeState(s)
    const row = this.store.getAgent(this.name)
    const promises = this.store.all("SELECT * FROM promises WHERE agent = ? AND status = 'open' ORDER BY id DESC LIMIT 3", this.name)
    const projects = [this.society.describeProjects(), ...promises.map(p => `- 約束(${this.society.displayName(p.to_agent)}へ): ${p.content}`)].filter(Boolean).join('\n')
    const messages = buildDecidePrompt({
      character: this.character,
      agentRow: row,
      stateText,
      memories: this._decideMemories(s, stateText, row),
      lessons: this.memory.lessons(3),
      relations: this.society.relations.describe(this.name, null, { withEvents: true }).split('\n').slice(0, 6).join('\n'),
      shared: this.society.shared.recent(4),
      projects,
      recentChat: this._recentChatText(),
      lastResult: this.lastResult,
      rejected: this.rejected,
      names: this.society.names().filter(n => n !== this.name).map(n => `${n}(${this.society.displayName(n)})`)
    })
    this.rejected = null
    return this.society.llm.requestJson(messages, { priority: PRIORITY.DECIDE, tag: `${this.name}:decide` })
  }

  // 状況に関係する記憶 + 近くにいる人間と前に話したこと (後日その話題を持ち出せるように)
  _decideMemories (s, stateText, row) {
    const mems = this.memory.recall(stateText + ' ' + (row.current_goal || ''), 6)
    const humans = s.players.filter(p => !p.isAgent && p.dist <= 24).map(p => p.name)
    for (const h of humans) {
      for (const m of this.memory.about(h, 2)) if (!mems.some(x => x.id === m.id)) mems.push({ ...m, content: `(${this.society.displayName(h)}について) ${m.content}` })
    }
    return mems.slice(0, 9)
  }

  async _handleDecision (d) {
    const day = this.day()
    if (d.thought) log.info(this.name, `💭 ${d.thought}`)
    if (d.goal && d.goal !== this.store.getAgent(this.name).current_goal) {
      this.store.updateAgent(this.name, { current_goal: String(d.goal).slice(0, 80) })
      this.memory.add('goal', `目標を「${d.goal}」にした`, { importance: 3, day })
    }
    if (d.long_goal) {
      this.store.updateAgent(this.name, { long_goal: String(d.long_goal).slice(0, 120) })
      this.memory.add('goal', `新しい夢: ${d.long_goal}`, { importance: 7, day })
      this.society.shared.add('goal', `${this.display}が新しい目標を持った: ${d.long_goal}`, { importance: 4, participants: [this.name], day })
    }
    if (d.promise?.to && d.promise?.content) this._makePromise(d.promise.to, d.promise.content)
    // 独り言・話しかけは控えめに: プレイヤーとの会話中は話さない、1人あたり一定間隔をあける
    const gap = (this.cfg.agent?.spontaneous_say_interval_sec ?? 60) * 1000
    if (d.say && !this.society.conversation.humanThreadActive() && Date.now() - (this.lastSpontaneous || 0) > gap) {
      this.lastSpontaneous = Date.now()
      await this.say(d.say, d.say_to || null)
    }
    // 行動は最大3つまでまとめて計画できる (LLMを毎回呼ばずに動き続けるため)
    const plan = (Array.isArray(d.actions) && d.actions.length ? d.actions : [d.action]).filter(x => x && x.name).slice(0, 3)
    for (let i = 0; i < plan.length; i++) {
      if (!this.running || this.pendingAction) break // 緊急事態やプレイヤーの頼みごとが入ったら計画を中断
      const ok = await this._execute(plan[i], 'decide')
      if (ok === false) break
    }
  }

  async _execute (action, source) {
    if (!this.ready()) return
    const s = this.state()
    let a = action
    if (source !== 'reflex') {
      const v = this.safety.vet(action, s)
      if (!v.ok) {
        this.rejected = `${action.name}: ${v.reason}`
        log.info(this.name, `🛡 却下 ${action.name} (${v.reason})`)
        this.memory.add('failure', `${action.name}をしようとしたが止めた: ${v.reason}`, { importance: 2, day: this.day() })
        return false
      }
      a = v.action
      if (v.reason) log.info(this.name, `🛡 修正 ${a.name} (${v.reason})`)
    }
    const def = ACTIONS[a.name]
    if (!def) { this.lastResult = `「${a.name}」という行動はできない`; return false }
    this.busy = true
    if (this._idling) { try { this.bot.pathfinder.setGoal(null) } catch {} ; this._idling = false }
    this.interruptFlag = false
    this.currentAction = { name: a.name, reflex: source === 'reflex' }
    const nearbyBefore = s.players.filter(p => p.isAgent && p.dist <= 8).map(p => p.name)
    log.info(this.name, `▶ ${a.name} ${JSON.stringify(a.args || {})}`)
    let result; let ok = true
    try {
      const timeout = (this.cfg.agent?.action_timeout_sec ?? 240) * 1000
      result = await withTimeout(def.run(this._ctx(), a.args || {}), timeout, a.name)
    } catch (e) {
      ok = false
      result = `${a.name}に失敗: ${e.message.slice(0, 100)}`
      try { this.bot.pathfinder.stop() } catch {}
    } finally {
      this.busy = false
      this.currentAction = null
    }
    if (this.interruptFlag) result += ' (緊急事態で中断)'
    this.interruptFlag = false
    this.lastResult = result
    log.info(this.name, `◀ ${result}`)
    const failed = !ok || /失敗|できない|ない$|足りない|見つからない|分からない|れなかった/.test(result)
    const imp = a.name === 'build_grave' || /完成/.test(result) ? 7 : failed ? 3 : 2
    this.memory.add(failed ? 'failure' : 'success', `${a.name}: ${result}`, { importance: imp, day: this.day() })
    if (!failed && ['collect', 'explore', 'build_house', 'fish', 'plant_and_harvest', 'build_grave', 'visit_grave'].includes(a.name)) {
      const nearbyAfter = this.state().players.filter(p => p.isAgent && p.dist <= 8).map(p => p.name)
      for (const other of nearbyBefore.filter(n => nearbyAfter.includes(n))) {
        const what = { collect: '採集した', explore: '探検した', build_house: '建築した', fish: '釣りをした', plant_and_harvest: '畑仕事をした', build_grave: 'お墓を建てた', visit_grave: 'お墓参りをした' }[a.name]
        this.society.noteTogether(this.name, other, what, this.day())
      }
    }
    return !failed
  }

  _ctx () {
    return { bot: this.bot, agent: this, store: this.store, interrupted: () => this.interrupted() }
  }

  // ------------------------------------------------------------------ 家・建築
  setHome (pos) {
    this.home = pos
    this.store.updateAgent(this.name, { home: pos })
    this.store.run('DELETE FROM protected_zones WHERE owner = ? AND kind = ?', this.name, 'home')
    this.store.run('INSERT INTO protected_zones (owner, kind, x, y, z, radius) VALUES (?, ?, ?, ?, ?, ?)', this.name, 'home', pos.x, pos.y, pos.z, 6)
    if (!this.store.getState('village_center')) this.store.setState('village_center', pos)
    this.memory.add('event', `(${pos.x},${pos.z})を自分の家に決めた`, { importance: 6, day: this.day() })
    this.society.shared.add('home', `${this.display}が(${pos.x},${pos.z})に住むことにした`, { importance: 4, participants: [this.name], day: this.day() })
  }

  addBuildProgress (kind, placed, total) {
    const key = `build:${this.name}:${kind}`
    const cur = this.store.getState(key, 0) + placed
    this.store.setState(key, cur)
    return Math.min(1, cur / total)
  }

  // ------------------------------------------------------------------ 会話
  async say (text, to = null, { voicePriority = 1, shout = null } = {}) {
    text = String(text || '').trim()
    // 小さいモデルが指示文をそのまま書き写したものは話さない
    if (/字以内|JSON|その場で口にする|返事をJSON|^\(.*\)$|null$/.test(text)) { log.debug(this.name, '指示文の書き写しを除外: ' + text); return }
    if (!text || !this.bot) return
    text = text.replace(/^[/\\]+/, '') // 住人の発言がコマンドとして実行されないように
    text = cleanSpeech(text)
    if (!text) return
    // 同じことを短い間に繰り返さない
    this._said = (this._said || []).filter(x => Date.now() - x.t < 180000)
    if (this._said.some(x => x.text === text)) { log.debug(this.name, '同じ発言の繰り返しを除外: ' + text); return }
    // 他の住人が少し前に言ったこととほぼ同じなら言わない (オウム返しの連鎖を防ぐ)
    const parrot = this.society.similarRecentLine?.(text, this.name)
    if (parrot) { log.info(this.name, `🦜 オウム返しなので言わない: ${text}`); return }
    this._said.push({ text, t: Date.now() })
    this.society.noteLine?.(this.name, text)
    // 叫び: 「おーい」「！！」や遠くの相手への呼びかけは遠くまで届く
    if (shout == null) shout = /^(おーい|ねえ[ー〜]|助けて|たすけて)|[!！]{2,}/.test(text)
    const display = this.society.display
    if (display?.enabled) {
      display.chat(this.character, text)    // チャット欄: 日本語の名前(色付き)
      display.bubble(this.character, text)  // 頭上の吹き出し
    } else {
      for (const chunk of splitChat(text)) {
        try { this.bot.chat(chunk) } catch {}
      }
    }
    const pos = this.bot.entity?.position
    const id = this.society.conversation.newMessageId()
    this.society.conversation.noteBotMessage(this.name, to)
    this.heard.push({ from: this.name, fromDisplay: this.display + '(自分)', text, t: Date.now() })
    this.heard = this.heard.slice(-20)
    this.memory.add('chat', `${to ? this.society.displayName(to) + 'に' : ''}「${text}」と言った`, { importance: 2, about: to, day: this.day() })
    log.info(this.name, `💬 ${this.display}: ${text}`)
    // 声は、プレイヤーの近くにいる住人のものだけ聞こえる (遠いほど小さく)
    const { volume: vol, pan } = this._voiceForPlayer(shout)
    if (vol > 0) this.society.voice?.speak(this.character, text, { priority: voicePriority, volume: vol, pan })
    this.society.bus.emit('say', { id, from: this.name, to, text, pos, shout })
  }

  // プレイヤーに聞こえる声の大きさと左右 (ふつう16ブロック・叫ぶと36ブロックまで届く)
  _voiceForPlayer (shout = false) {
    const range = shout ? (this.cfg.conversation?.shout_range ?? 36) : (this.cfg.voice?.range ?? this.cfg.conversation?.hearing_range ?? 16)
    const pe = this.bot?.players?.[this.cfg.player?.name]?.entity
    const me = this.bot?.entity?.position
    if (!pe || !me) return { volume: 0, pan: 0 } // プレイヤーが近くにいない (または未ログイン) なら声は出さない
    const d = pe.position.distanceTo(me)
    if (d > range) return { volume: 0, pan: 0 }
    return { volume: Math.max(0.25, 1 - d / range), pan: panFor(pe, me) }
  }

  _voiceVolumeForPlayer () { return this._voiceForPlayer().volume }

  // 他のAIの発言 (プロセス内バス経由で確実に受け取る)
  hearBot (msg) {
    if (msg.from === this.name || !this.alive) return
    const me = this.bot?.entity?.position
    const distance = me && msg.pos ? me.distanceTo(msg.pos) : null
    const range = msg.shout ? (this.cfg.conversation?.shout_range ?? 36) : (this.cfg.conversation?.hearing_range ?? 16)
    const addressedNames = msg.to ? [msg.to] : findAddressed(msg.text, this._allAliases())
    const addressed = this._resolveAliases(addressedNames)
    if (distance != null && distance > range) return // 聞こえない (名前を呼ばれても、届かなければ聞こえない)
    this._hear({ id: msg.id, from: msg.from, fromIsBot: true, text: msg.text, addressed, distance })
  }

  _onGameChat (username, message) {
    if (username === this.name || this.society.isAgent(username)) return // AIの発言はバスで受け取る
    // 人間の発言は「進行役」が一度だけ処理する (同じ発言が全ボットから届くので重複は進行役が除く)
    this.society.floor.handleHuman(username, message, { source: 'chat' }).catch(e => log.warn('floor', e.message))
  }

  // 人間の発言を聞いた (進行役から呼ばれる)。返事するかどうかは進行役が決める
  hearHuman (from, text, { toMe = false, isGroup = false, source = 'chat' } = {}) {
    const fromDisplay = this.society.displayName(from)
    this.lastHumanSpeaker = from
    if (toMe || isGroup) this.lastHumanTalkAt = Date.now()
    this.heard.push({ from, fromDisplay, text, t: Date.now() })
    this.heard = this.heard.slice(-20)
    const how = toMe ? 'が自分に' : isGroup ? 'がみんなに' : 'が'
    this.memory.add('chat', `${fromDisplay}${how}${source === 'voice' ? '声で' : ''}「${text}」と言った`, { importance: toMe || isGroup ? 4 : 2, about: from, day: this.day() })
  }

  _allAliases () {
    const out = []
    for (const c of this.society.characters.values()) out.push(c.username, c.display_name, ...(c.nicknames || []))
    return out
  }

  _resolveAliases (found) {
    const f = found.map(normName)
    const res = new Set()
    for (const c of this.society.characters.values()) {
      if ([c.username, c.display_name, ...(c.nicknames || [])].some(n => f.includes(normName(n)))) res.add(c.username)
    }
    return [...res]
  }

  _hear (msg) {
    msg.t = Date.now()
    const fromDisplay = this.society.displayName(msg.from)
    this.heard.push({ from: msg.from, fromDisplay, text: msg.text, t: Date.now() })
    this.heard = this.heard.slice(-20)
    const toMe = msg.addressed.includes(this.name)
    this.memory.add('chat', `${fromDisplay}${toMe ? 'が自分に' : 'が'}「${msg.text}」と言った`, { importance: toMe ? 3 : 1, about: msg.from, day: this.day() })
    const ok = this.society.conversation.shouldReply(this.name, msg, { sociability: this.character.sociability ?? 0.5 })
    if (ok) this.inbox.push(msg)
  }

  async _replyLoop () {
    while (this.running) {
      if (!this.inbox.length || !this.ready() || !this.alive) { await sleep(300); continue }
      const msg = this.inbox.shift()
      const age = Date.now() - (msg.t || Date.now())
      if (age > (msg.fromIsBot ? 20000 : 60000)) continue // 古い話題には今さら返事しない
      try { await this._reply(msg) } catch (e) { log.warn(this.name, '返事に失敗: ' + e.message) }
    }
  }

  async _reply (msg) {
    return this._replyCore({ from: msg.from, text: msg.text, isHuman: !msg.fromIsBot })
  }

  // プレイヤーとの会話の中で返事する (進行役から順番に呼ばれる)
  async respondInThread (thread, { stance = null, why = '', isGroup = false } = {}) {
    return this._replyCore({ from: thread.from, text: thread.text, isHuman: true, thread: thread.lines, stance, why, isGroup, voicePriority: 0, llmPriority: PRIORITY.HUMAN })
  }

  async _replyCore ({ from, text, isHuman, thread = null, stance = null, why = '', isGroup = false, voicePriority = 1, llmPriority = null }) {
    const speakerDisplay = this.society.displayName(from)
    const s = this.state()
    if (isHuman) this.society.relations.init(this.name, from, { label: '人間の仲間' })
    const relRow = this.society.relations.get(this.name, from)
    const relationText = relRow ? this.society.relations.describe(this.name, [from]) : ''
    const others = s.players.filter(p => p.isAgent && p.dist <= 32).map(p => `${p.name}(${this.society.displayName(p.name)})`)
    const messages = buildReplyPrompt({
      character: this.character,
      agentRow: this.store.getAgent(this.name),
      speakerDisplay,
      text,
      isHuman,
      relationText,
      aboutMemories: this.memory.recall(`${speakerDisplay} ${text}`, 5).filter(m => m.about === from || m.importance >= 5).slice(0, 4).concat(this.memory.about(from, 2)).slice(0, 5),
      recentChat: this._recentChatText(6),
      stateText: describeState(s).split('\n').slice(0, 3).join('\n'),
      thread,
      stance,
      why,
      isGroup,
      others
    })
    const r = await this.society.llm.requestJson(messages, { priority: llmPriority ?? (isHuman ? PRIORITY.HUMAN : PRIORITY.CHAT), tag: `${this.name}:reply` })
    const gap = this.cfg.conversation?.reply_delay_ms ?? 800
    await sleep(gap)
    const day = this.day()
    if (r.relationship_event?.type) {
      this.society.relations.record(this.name, from, `${speakerDisplay}「${text.slice(0, 30)}」→${r.relationship_event.note || r.relationship_event.type}`, r.relationship_event.type, { day })
      if (['insulted', 'quarrel'].includes(r.relationship_event.type)) {
        this.memory.add('event', `${speakerDisplay}と気まずくなった: ${r.relationship_event.note || ''}`, { importance: 6, about: from, day })
      }
      if (['apology', 'reconciled', 'mediated'].includes(r.relationship_event.type)) {
        this.memory.add('event', `${speakerDisplay}と仲直りした: ${r.relationship_event.note || ''}`, { importance: 6, about: from, day })
      }
    }
    if (r.promise?.to && r.promise?.content) this._makePromise(r.promise.to, r.promise.content)
    if (r.goal) {
      this.store.updateAgent(this.name, { current_goal: String(r.goal).slice(0, 80) })
      this.memory.add('goal', `${speakerDisplay}との話で目標を「${r.goal}」にした`, { importance: 5, about: from, day })
    }
    if (r.say) await this.say(r.say, from, { voicePriority })
    const allowed = isHuman ? REQUEST_ACTIONS : ['go_to_player', 'follow', 'give', 'rest']
    if (r.action?.name && allowed.includes(r.action.name) && !this.pendingAction?.reflex) {
      this.pendingAction = { name: r.action.name, args: r.action.args || {} }
      if (isHuman) this.memory.add('goal', `${speakerDisplay}に頼まれて${r.action.name}をすることにした`, { importance: 4, about: from, day })
      if (this.busy) { this.interruptFlag = true; try { this.bot.pathfinder.stop() } catch {} } // 頼みごとを優先
    }
    return r
  }

  _makePromise (to, content) {
    const target = this._resolveAliases([to])[0] || to
    this.store.run('INSERT INTO promises (agent, to_agent, content, day, created_at) VALUES (?, ?, ?, ?, ?)', this.name, target, String(content).slice(0, 120), this.day(), Date.now())
    this.memory.add('goal', `${this.society.displayName(target)}と約束した: ${content}`, { importance: 6, about: target, day: this.day() })
  }

  onGave (to, item, n) {
    const day = this.day()
    this.memory.add('event', `${this.society.displayName(to)}に${item}を${n}個あげた`, { importance: 4, about: to, day })
    const other = this.society.agents.get(to)
    if (other) {
      other.memory.add('event', `${this.display}から${item}を${n}個もらった`, { importance: 5, about: this.name, day })
      this.society.relations.record(to, this.name, `${this.display}から${item}をもらった`, 'gift', { day })
    }
  }

  // ------------------------------------------------------------------ 人間のログイン
  _onPlayerJoined (player) {
    const name = player.username
    if (!name || name === this.name || this.society.isAgent(name)) return
    const key = `human_last_seen:${name}`
    const last = this.store.getState(key)
    // 歓迎役は1人だけ (最もその人と親しいAI)
    const greeter = this.society.aliveAgents()
      .map(a => ({ a, r: this.society.relations.get(a.name, name) }))
      .sort((x, y) => ((y.r?.affinity || 0) + (y.r?.trust || 0)) - ((x.r?.affinity || 0) + (x.r?.trust || 0)))[0]?.a
    this.memory.add('event', `${name}がやってきた`, { importance: 3, about: name, day: this.day() })
    if (greeter !== this) return
    this.store.setState(key, Date.now())
    const hours = last ? Math.round((Date.now() - last) / 3600000) : null
    const text = hours == null ? '(初めてこの世界にやってきた)' : `(${hours}時間ぶりにこの世界に戻ってきた)`
    setTimeout(() => this.inbox.push({ id: `join:${name}:${Date.now()}`, from: name, fromIsBot: false, text, addressed: [this.name], t: Date.now() }), 4000)
  }

  // ------------------------------------------------------------------ 時間・日記
  _onTime () {
    const d = this.bot.time?.day
    if (d == null) return
    if (this.lastDayObserved == null) { this.lastDayObserved = d; return }
    if (d > this.lastDayObserved) {
      const finished = this.lastDayObserved
      this.lastDayObserved = d
      this.writeDiary(finished).catch(e => log.warn(this.name, '日記の失敗: ' + e.message))
    }
  }

  async writeDiary (day) {
    const row = this.store.getAgent(this.name)
    if (row.last_diary_day >= day) return null
    this.store.updateAgent(this.name, { last_diary_day: day })
    let today = this.store.all('SELECT * FROM memories WHERE agent = ? AND day = ? AND archived = 0 ORDER BY importance DESC, id ASC LIMIT 25', this.name, day)
    if (!today.length) today = this.memory.recent(15)
    const openPromises = this.store.all("SELECT * FROM promises WHERE agent = ? AND status = 'open'", this.name)
    const messages = buildDiaryPrompt({
      character: this.character,
      agentRow: row,
      day,
      todayMemories: [...today, ...openPromises.map(p => ({ content: `(未完了の約束#${p.id}) ${this.society.displayName(p.to_agent)}へ: ${p.content}` }))],
      relations: this.society.relations.describe(this.name, null, { withEvents: false }),
      names: this.society.names().filter(n => n !== this.name).map(n => `${n}(${this.society.displayName(n)})`)
    })
    messages[0].content += '\n任意で "promises_kept":[約束の番号] と "promises_broken":[約束の番号] も書ける (守れた/破ってしまった約束)。'
    const r = await this.society.llm.requestJson(messages, { priority: PRIORITY.REFLECT, tag: `${this.name}:diary` })
    const text = String(r.diary || '').trim()
    if (text) {
      this.store.run('INSERT OR REPLACE INTO diaries (agent, day, content, created_at) VALUES (?, ?, ?, ?)', this.name, day, text + (r.tomorrow ? `\n明日やりたいこと: ${r.tomorrow}` : ''), Date.now())
      this.memory.add('reflection', `${day}日目の日記: ${text.slice(0, 200)}`, { importance: 5, day })
      log.info(this.name, `📔 ${day}日目の日記: ${text.slice(0, 80)}…`)
    }
    if (r.tomorrow) this.store.updateAgent(this.name, { current_goal: String(r.tomorrow).slice(0, 80) })
    for (const im of r.impressions || []) {
      const target = this._resolveAliases([im.name])[0]
      if (target && target !== this.name && im.impression) this.society.relations.setImpression(this.name, target, String(im.impression).slice(0, 80), im.label || null)
    }
    if (r.growth) {
      const g = ((row.growth ? row.growth + ' / ' : '') + r.growth).slice(-400)
      this.store.updateAgent(this.name, { growth: g })
    }
    if (r.lesson) this.memory.add('lesson', r.lesson, { importance: 7, day })
    for (const [ids, status, type] of [[r.promises_kept, 'kept', 'promise_kept'], [r.promises_broken, 'broken', 'promise_broken']]) {
      for (const id of ids || []) {
        const p = openPromises.find(x => x.id === Number(id))
        if (!p) continue
        this.store.run('UPDATE promises SET status = ? WHERE id = ?', status, p.id)
        if (this.society.isAgent(p.to_agent)) this.society.relations.record(p.to_agent, this.name, `${this.display}が約束「${p.content}」を${status === 'kept' ? '守った' : '破った'}`, type, { day })
      }
    }
    // 記憶の整理 (古い細かな記憶を要約)
    await this.memory.consolidate(async texts => {
      const s = await this.society.llm.requestJson(buildSummarizePrompt(this.display, texts), { priority: PRIORITY.REFLECT, tag: `${this.name}:summary` })
      return s.summary
    })
    return text
  }

  // ------------------------------------------------------------------ 死亡
  async _onDeath () {
    const pos = this.bot.entity?.position
    const p = pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null
    await sleep(600)
    const m = this.lastDeathMsg && Date.now() - this.lastDeathMsg.t < 5000 ? this.lastDeathMsg.msg : null
    const cause = m ? m.replace(this.name, '').trim() : '不明な原因'
    const day = this.day()
    const permanent = !!this.cfg.death?.permanent
    this.store.run('INSERT INTO deaths (agent, cause, x, y, z, dimension, day, permanent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      this.name, cause, p?.x ?? null, p?.y ?? null, p?.z ?? null, this.bot.game?.dimension || null, day, permanent ? 1 : 0, Date.now())
    const row = this.store.getAgent(this.name)
    const caution = Math.min(6, (row.caution || 0) + 1)
    this.store.updateAgent(this.name, { deaths: (row.deaths || 0) + 1, caution })
    this.safety.setCaution(caution)
    const lesson = Safety.lessonFromDeath(cause)
    this.memory.add('death', `${day}日目に${cause}で死んでしまった${p ? ` (場所 ${p.x},${p.y},${p.z})` : ''}`, { importance: 9, day })
    this.memory.add('lesson', lesson, { importance: 8, day })
    log.warn(this.name, `☠ 死亡: ${cause} → 教訓「${lesson}」 慎重さ${caution}`)
    this.interruptFlag = true
    if (permanent) {
      this.alive = false
      this.store.updateAgent(this.name, { alive: 0 })
      this.society.shared.add('memorial', `${this.display}の家と持ち物はそのまま残されている`, { importance: 6, participants: [this.name], day })
      setTimeout(() => this.stop(), 3000)
    }
    this.society.onAgentDeath(this.name, { cause, pos: p, day, permanent }).catch(e => log.warn('society', e.message))
  }

  async reactToDeath (dead, { cause, permanent, day, how = 'saw' }) {
    if (!this.alive) return null
    if (!permanent && !this.cfg.death?.react_on_respawn) {
      // 復活するモードでは、いちいち悲しまない。見た/聞いた出来事として覚えるだけ
      const d = this.society.displayName(dead)
      this.memory.add('event', how === 'saw' ? `${d}が${cause}で倒れるのを見た (復活した)` : `どこかで${d}の悲鳴が聞こえた`, { importance: 3, about: dead, day })
      return null
    }
    const deadDisplay = this.society.displayName(dead)
    const messages = buildDeathReactionPrompt({
      character: this.character,
      agentRow: this.store.getAgent(this.name),
      deadDisplay,
      cause,
      permanent,
      relationText: this.society.relations.describe(this.name, [dead]),
      aboutMemories: this.memory.about(dead, 4)
    })
    const rel = this.society.relations.get(this.name, dead)
    const closeness = rel ? (rel.affinity + rel.trust) / 2 : 0
    this.memory.add('death', `${deadDisplay}が${cause}で${permanent ? '亡くなった' : '死んでしまった'}`, { importance: permanent ? 10 : Math.max(5, Math.min(9, 5 + Math.round(closeness / 25))), about: dead, day })
    let r
    try {
      r = await this.society.llm.requestJson(messages, { priority: PRIORITY.URGENT, tag: `${this.name}:grief` })
    } catch { return null }
    if (r.feeling) this.memory.add('reflection', `${deadDisplay}の死について: ${r.feeling}`, { importance: 7, about: dead, day })
    if (r.new_goal) {
      this.store.updateAgent(this.name, { current_goal: String(r.new_goal).slice(0, 80) })
      this.memory.add('goal', `${deadDisplay}の死をきっかけに: ${r.new_goal}`, { importance: 7, about: dead, day })
    }
    if (r.say) await this.say(r.say, null)
    return r
  }
}

export { Relationships }

// プレイヤーの向きから見て、話し手が左右どちらにいるか (-1=左 〜 1=右)
export function panFor (playerEntity, speakerPos) {
  const p = playerEntity.position
  const dx = speakerPos.x - p.x; const dz = speakerPos.z - p.z
  const d = Math.hypot(dx, dz)
  if (d < 1) return 0
  const y = playerEntity.yaw || 0
  // mineflayer の yaw: 向いている方向 = (-sin y, -cos y)、右手方向 = (cos y, -sin y)
  return Math.max(-1, Math.min(1, (dx * Math.cos(y) - dz * Math.sin(y)) / d))
}

// 小さいモデルが日本語の後ろに付けてしまう英語のゴミ (例: 「探そう！startTime」) を取る
const ITEM_JA = {
  stone_pickaxe: '石のツルハシ', wooden_pickaxe: '木のツルハシ', iron_pickaxe: '鉄のツルハシ', diamond_pickaxe: 'ダイヤのツルハシ',
  stone_sword: '石の剣', wooden_sword: '木の剣', iron_sword: '鉄の剣', stone_axe: '石の斧', wooden_axe: '木の斧', iron_axe: '鉄の斧',
  oak_log: '原木', log: '原木', oak_planks: '板材', planks: '板材', crafting_table: '作業台', cobblestone: '丸石', stone: '石',
  coal_ore: '石炭', coal: '石炭', iron_ore: '鉄鉱石', iron_ingot: '鉄', diamond_ore: 'ダイヤ', diamond: 'ダイヤ', bread: 'パン',
  torch: '松明', white_bed: 'ベッド', bed: 'ベッド', chest: 'チェスト', wheat: '小麦', furnace: 'かまど', stick: '棒', dirt: '土', sand: '砂',
  zombie: 'ゾンビ', skeleton: 'スケルトン', spider: 'クモ', creeper: 'クリーパー', cow: '牛', pig: '豚', sheep: '羊', chicken: 'ニワトリ'
}

export function cleanSpeech (text) {
  let t = String(text || '').trim()
  // アイテムのIDを日本語に (stone_pickaxe → 石のツルハシ)
  t = t.replace(/[a-z][a-z_]*[a-z]/g, w => ITEM_JA[w] || w)
  // 日本語の直後に続く英字だけの単語 (4文字以上・末尾) を削除
  t = t.replace(/([\u3000-\u9fff\uff00-\uffef！？。、]) ?[A-Za-z_]{4,}[.!?]*$/u, '$1')
  // 日本語の文中に混ざったプログラム用の単語 (camelCase)
  t = t.replace(/(^|[^A-Za-z])[a-z]+[A-Z][A-Za-z]*(?![A-Za-z])/g, '$1')
  return t.replace(/\s{2,}/g, ' ').trim()
}

