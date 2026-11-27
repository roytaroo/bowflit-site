// 1人のAI住人。
//  [通常のプログラム] 接続・知覚・反射行動・安全審査・行動実行・記録
//  [LLM]             行動の意思決定・目標設定・会話・日記・死への反応
import { createRequire } from 'node:module'
import { snapshot, describeState, relativePlace } from './perception.js'
import { DECIDE_ACTIONS } from './prompts.js'
import { voiceIssues, fixVoice } from './voiceStyle.js'
import { requestFromText } from './requests.js'
import { Body } from '../body/body.js'
import { DAY_TASKS } from '../society/meeting.js'
import { Safety } from './safety.js'
import { Experience, causeJa } from './experience.js'
import { ACTIONS } from './actions.js'
import { AgentMemory } from '../memory/memory.js'
import { Relationships } from '../society/relationships.js'
import { findAddressed, splitChat, normName } from '../society/conversation.js'
import { PRIORITY } from '../llm/client.js'
import { REQUEST_ACTIONS, buildDecidePrompt, buildReplyPrompt, buildDiaryPrompt, buildDeathReactionPrompt, buildSummarizePrompt, buildLastWordsPrompt, buildWitnessPrompt, buildRespawnPrompt } from './prompts.js'
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
    this.houseSite = this.store.getState(`house_site:${this.name}`, null) // 家を建てている場所
    const village = this.store.getState('village', null)
    if (village) this.moveIntoVillage(village)
    this.dayPlan = this.store.getState(`day_plan:${this.name}`, null)
    this.memory = new AgentMemory(this.store, this.name, this.cfg.memory || {})
    this.safety = new Safety(this.cfg.safety || {}, this.row)
    this.experience = new Experience(this) // 死んだ・やられた・迷子・見つけた などの経験 (次の行動に反映)
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
    const { Movements } = require('mineflayer-pathfinder')
    // 体の準備: 経路探索・採掘・戦闘・自動で食べる・防具を着る、と Paper 向けの対策 (src/body)
    Body.prepare(bot)

    bot.once('spawn', () => {
      this.reconnects = 0
      // 体: 行動を1つずつ実行し、裏で「モード」(溺れる・はまる・敵・落ちている物・松明・きょろきょろ) を回す
      try { this.body?.stop() } catch {}
      this.body = new Body(bot, {
        modes: this.cfg.agent?.modes || {},
        onModeSay: m => log.debug(this.name, `[mode] ${m}`),
        onModeFinished: (mode, interrupted) => {
          if (interrupted && !/^mode:/.test(interrupted)) log.info(this.name, `⚡ ${MODE_JA[mode] || mode} のため「${interrupted}」を中断`)
        }
      })
      try { bot.autoEat.options = { ...bot.autoEat.options, priority: 'foodPoints', startAt: 14, bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'] } } catch {}
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
      bot.pathfinder.setMovements(m) // 普段の歩き方 (行動の中ではスキルがそれぞれ歩き方を決める)

      log.info(this.name, `${this.display} がワールドに参加 (${bot.version})`)
      this.memory.add('event', 'ワールドで目を覚ました', { importance: 2, day: this.day() })
      this._reflexTimer = setInterval(() => this._reflexTick(), 1000)
    })

    // スポーンのたび (リスポーン含む) に頭上の名前・吹き出しを付け直す
    bot.on('spawn', () => setTimeout(() => this.society.display?.attach(this.character), 1500))
    bot.on('chat', (username, message) => this._onGameChat(username, message))
    // 設定の本のボタン (だいきからのささやき「#set ...」)
    bot.on('whisper', (username, message) => { try { this.society.settings?.handle(username, message) } catch (e) { log.warn('settings', e.message) } })
    bot.on('messagestr', (msg, position) => {
      if (position === 'chat') return
      if (msg.startsWith(this.name + ' ') && DEATH_WORDS.test(msg)) this.lastDeathMsg = { msg, t: Date.now() }
    })
    bot.on('death', () => this._onDeath().catch(e => log.error(this.name, 'death処理失敗: ' + e.message)))
    bot.on('health', () => this._onHealth())
    bot.on('spawn', () => { if (this._justDied) { const d = this._justDied; this._justDied = null; setTimeout(() => this._onRespawn(d).catch(e => log.warn(this.name, e.message)), 3000) } })
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
    try { this.body?.stop() } catch {}
    this.society.display?.detach(this.character)
    clearInterval(this._reflexTimer)
    try { this.bot?.quit() } catch {}
  }

  // メモリが危ないときなどに、移動・戦闘・実行中の行動をすぐ止める
  emergencyStop () {
    if (!this.bot) return
    this.interruptFlag = true
    try { this.body?.requestInterrupt() } catch {}
    try { this.bot.pathfinder?.stop(); this.bot.pathfinder?.setGoal(null) } catch {}
    try { this.bot.pvp?.stop() } catch {}
  }

  ready () { return !!(this.bot && this.bot.entity && this.bot.pathfinder) }

  interrupted () { return this.interruptFlag || !this.running }

  // ------------------------------------------------------------------ 反射 (LLMなし)
  _reflexTick () {
    if (!this.ready() || !this.alive) return
    const s = this.state({ scanBlocks: false }) // 毎秒なのでブロックの走査はしない
    // 溺れる・燃える・敵・はまる・食べる は「体」のモードと自動で食べる機能がやるので、ここは夜に寝ることだけ
    const r = this.body ? this._bedtime(s) : (this.safety.reflex(s) || this._bedtime(s))
    if (!r) return
    if (this.currentAction?.reflex && this.currentAction.name === r.name) return
    if (this.pendingAction?.reflex && this.pendingAction.name === r.name) return // もう予約済み (ログを何度も出さない)
    if (this.busy) {
      log.info(this.name, `反射行動: ${r.name} (${r.reason}) → 現在の行動を中断`)
      this.interruptFlag = true
      try { this.body?.requestInterrupt(); this.bot.pathfinder.stop(); this.bot.pvp?.stop() } catch {}
    }
    this.pendingAction = { ...r, reflex: true }
  }

  // 夜になったら、ベッドを持っている(置いてある)住人は寝る。夜の外は危ないので LLM の判断を待たない
  _bedtime (s) {
    if (this.cfg.world?.auto_sleep === false) return null // 設定で「夜は寝る」を切っている
    // 遠く・地下にいるときは、夕方より早めに (夜まであと約1分半) 家へ向かい始める
    if (this.village && s.timeOfDay != null && s.timeOfDay >= 10000 && s.timeOfDay < 11800 && s.pos && !this._headingHome) {
      const h = this.village.center
      const far = Math.hypot(s.pos.x - h.x, s.pos.z - h.z) > 40 || s.pos.y < h.y - 8
      if (far && this.currentAction?.name !== 'go_home') { this._headingHome = true; return { name: 'go_home', args: {}, reason: 'もうすぐ夜なので、遠くから家に戻る' } }
    }
    if (s.timeOfDay != null && s.timeOfDay < 10000) this._headingHome = false
    // みんなの家があれば、日が暮れ始めたら (夕方) 家に帰り始める
    const dusk = s.night || (this.village && s.timeOfDay != null && s.timeOfDay >= 11800 && s.timeOfDay < 23000)
    if (this.cfg.world?.auto_sleep === false || !dusk || this.bot.isSleeping) return null
    if (this.currentAction?.name === 'sleep' || Date.now() - (this._lastBedTry || 0) < 45000) return null
    const hasBed = s.inventory.some(i => i.name.endsWith('_bed')) || this.bedPos
    if (!hasBed || s.hostiles.some(h => h.dist <= 10) || s.inWater) return null
    this._lastBedTry = Date.now()
    return { name: 'sleep', args: {}, reason: '夜になったので寝る' }
  }

  state ({ scanBlocks = true } = {}) {
    const s = snapshot(this.bot, { home: this.home, knownAgents: this.society.names(), scanBlocks })
    s.newBody = !!this.body
    if (scanBlocks) {
      // 安全管理の審査用: お墓の一覧と、さっき計画を提案したか
      try { s.graves = this.store.all('SELECT for_agent FROM graves').map(g => g.for_agent) } catch { s.graves = [] }
      try { s.recentProposal = !!this.store.get('SELECT id FROM projects WHERE proposed_by = ? AND created_at > ?', this.name, Date.now() - 15 * 60000) } catch {}
    }
    return s
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

  // ペコペコ (しゃがみを数回) してあいさつする
  async _bow (times = 2) {
    if (this._bowing || !this.bot) return
    this._bowing = true
    try {
      for (let i = 0; i < times; i++) {
        this.bot.setControlState('sneak', true); await sleep(250)
        this.bot.setControlState('sneak', false); await sleep(250)
      }
    } catch {} finally { this._bowing = false }
  }

  // 出会ったとき・目が合ったときのあいさつ (考え中でも作業中でも反応する)
  _greetTick () {
    const bot = this.bot
    if (!this.ready() || !this.alive || bot.isSleeping || this.cfg.agent?.greetings === false) return
    const me = bot.entity.position
    const now = Date.now()
    this._seen = this._seen || new Map()
    for (const p of Object.values(bot.players)) {
      if (!p.entity || p.username === this.name) continue
      const d = p.entity.position.distanceTo(me)
      const isHuman = !this.society.isAgent(p.username)
      const last = this._seen.get(p.username) || { near: false, t: 0, bow: 0 }
      // 出会い: しばらく離れていた相手が近づいてきた
      if (d <= 6 && !last.near && now - last.t > 60000 && now - last.bow > 30000 && (isHuman || Math.random() < 0.5)) {
        last.bow = now
        if (!this.busy) bot.lookAt(p.entity.position.offset(0, 1.6, 0)).catch(() => {})
        this._bow(isHuman ? 3 : 2)
      }
      // 目が合った: 人間がこっちをまっすぐ見ている
      if (isHuman && d <= 10 && now - last.bow > 15000 && lookingAt(p.entity, me)) {
        last.bow = now
        if (!this.busy) bot.lookAt(p.entity.position.offset(0, 1.6, 0)).catch(() => {})
        this._bow(2)
      }
      if (d <= 6) { last.near = true; last.t = now } else if (d > 10) last.near = false
      this._seen.set(p.username, last)
    }
  }

  // 見かけた人を、いつ・どこで見たか覚えておく (「3分前に家から東へ約56ブロックで見た」と答えられるように)
  _noteSightings () {
    const bot = this.bot
    if (!bot?.entity) return
    this.sightings = this.sightings || {}
    const me = bot.entity.position
    const home = this.village?.center || this.home
    for (const p of Object.values(bot.players)) {
      if (!p.entity || p.username === this.name) continue
      if (p.entity.position.distanceTo(me) > 24) continue
      this.sightings[p.username] = { t: Date.now(), place: relativePlace(p.entity.position, home) }
    }
  }

  sightingsText (names = null) {
    const list = Object.entries(this.sightings || {})
      .filter(([n]) => !names || names.includes(n))
      .sort((a, b) => b[1].t - a[1].t).slice(0, 8)
    if (!list.length) return ''
    return list.map(([n, v]) => {
      const min = Math.round((Date.now() - v.t) / 60000)
      return `- ${this.society.displayName(n)}: ${min <= 0 ? 'さっき' : `${min}分前に`}${v.place}で見た`
    }).join('\n')
  }

  _idleStep (n) {
    try { this._greetTick() } catch {}
    if (n % 4 === 0) try { this._noteSightings() } catch {}
    const bot = this.bot
    if (!this.ready() || !this.alive || this.busy || this.pendingAction || bot.isSleeping) { this._idling = false; return }
    if (this.body && !this.body.isIdle()) return // 体が反射の動き (物を拾う・反撃など) をしている
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
    if (this.body) return // きょろきょろ・少し歩くは体のモード (idle_staring) がやる
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
    while (this.running) {
      const minGap = this.cfg.agent?.decide_interval_ms ?? 5000 // 設定の本で変えられるので毎回読む
      try {
        if (!this.ready() || !this.alive) { await sleep(1000); continue }
        if (this.pendingAction) {
          const a = this.pendingAction; this.pendingAction = null
          await this._execute(a, a.reflex ? 'reflex' : 'reply')
          continue
        }
        // 朝の会議の間は、考えるのも仕事も止めて会議に出る
        if (this.society.meetingActive) { await sleep(1000); continue }
        const since = Date.now() - this.lastDecision
        // 待ち時間は、ぼーっとせずに自分の仕事 (素材集めなど) をする
        if (since < minGap) { await this._choreOnce(); continue }
        // プレイヤーへの返事を作っている間は、次の行動を考えるのを待つ (AIを返事に専念させる)
        if (this.society.floor?.busy?.()) { await this._choreOnce(); continue }
        // LLMが混んでいるときは待つ (9人が一斉に考えて詰まらないように)
        const maxPending = this.cfg.llm?.max_pending ?? Math.max(2, this.society.aliveAgents().length)
        if (this.society.llm.pending() >= maxPending) { await this._choreOnce(); continue }
        this.lastDecision = Date.now()
        // AIが考えている間も手を止めずに仕事をする。考えがまとまったら、そちらに切り替える
        const decision = await this._workUntil(this._decide())
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

  // ------------------------------------------------------------------ 自分の仕事 (LLMなし)
  // 足りない素材を集める → 家の場所を決める → 家を建てる → 役割の仕事、の順に、状況を見て自分で選ぶ
  _pickChore () {
    if (this.cfg.agent?.auto_work === false) return null
    const s = this.state({ scanBlocks: false })
    const dusk = this.village && s.timeOfDay != null && s.timeOfDay >= 11800 && s.timeOfDay < 23000
    if (s.night || dusk || s.inWater || s.health < 10 || s.hostiles.some(h => h.dist < 12) || this.bot.isSleeping) return null
    const now = Date.now()
    this._choreBan = this._choreBan || {}
    const ok = key => !(this._choreBan[key] > now)
    const count = re => s.inventory.filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)
    const logs = count(/_log$/); const planks = count(/_planks$/); const stone = count(/^(cobblestone|stone|cobbled_deepslate)$/)
    const mats = logs * 4 + planks + stone
    if (this.society.meetingActive) return null
    const gift = this._giftChore(s)
    if (gift) return gift
    // 朝の会議で決めた今日の仕事 (約束した相手がいれば、まずその人のそばへ)
    const plan = this.dayPlan
    if (plan && plan.day === s.day && DAY_TASKS[plan.task]) {
      if (plan.with) {
        const p = this.bot.players[plan.with]?.entity
        if (p && p.position.distanceTo(this.bot.entity.position) > 12 && ok('join:' + plan.with)) return { name: 'go_to_player', args: { name: plan.with }, key: 'join:' + plan.with }
      }
      const c = this._dayTaskChore(plan.task, s)
      if (c && ok('day:' + plan.task + JSON.stringify(c.args))) return { ...c, key: 'day:' + plan.task + JSON.stringify(c.args) }
    }
    if (logs * 4 + planks < 16 && ok('log')) return { name: 'collect', args: { block: 'log', count: 6 }, key: 'log' }
    // ツルハシが無ければ作る (壊れたときも)。丸石があれば石のツルハシ
    if (!s.inventory.some(i => /_pickaxe$/.test(i.name)) && ok('pickaxe')) {
      return { name: 'craft', args: { item: stone >= 3 ? 'stone_pickaxe' : 'wooden_pickaxe', count: 1 }, key: 'pickaxe' }
    }
    if (stone < 24 && ok('stone')) return { name: 'collect', args: { block: 'stone', count: 8 }, key: 'stone' }
    // だいきに「建築して」と頼まれていたら、少ない素材でもすぐ建て始める
    const buildFocus = this.focus?.kind === 'build' && this.focus.until > now
    const needHome = buildFocus ? 20 : 50; const needBuild = buildFocus ? 20 : 40
    if (!this.home && mats >= needHome && ok('home')) return { name: 'set_home', args: {}, key: 'home' }
    if (this.home && mats >= needBuild && ok('build') && (this.store.getState(`build:${this.name}:house`, 0) < 70)) return { name: 'build_house', args: { size: 5 }, key: 'build' }
    if (buildFocus && logs * 4 + planks < 40 && ok('log')) return { name: 'collect', args: { block: 'log', count: 8 }, key: 'log' }
    // 役割ごとの仕事 (キャラ設定の chores から)
    const chores = (this.character.chores || []).filter(c => ok('role:' + c.name + JSON.stringify(c.args || {})))
    if (chores.length) { const c = chores[Math.floor(Math.random() * chores.length)]; return { ...c, key: 'role:' + c.name + JSON.stringify(c.args || {}) } }
    if (logs < 32 && ok('log')) return { name: 'collect', args: { block: 'log', count: 8 }, key: 'log' }
    return null
  }

  // 今日の仕事を、実際の行動1回分にする
  _dayTaskChore (task, s) {
    if (task === 'tools') {
      const has = n => s.inventory.some(i => i.name === n)
      const item = ['stone_pickaxe', 'stone_sword', 'stone_axe', 'stone_shovel'].find(n => !has(n))
      if (item) return { name: 'craft', args: { item, count: 1 } }
      return { name: 'craft', args: { item: 'torch', count: 8 } }
    }
    if (task === 'food') return { name: 'attack', args: { target: 'animal' } }
    if (task === 'explore') return { name: 'explore', args: { direction: ['north', 'south', 'east', 'west'][Math.floor(Math.random() * 4)], distance: 64 } }
    return DAY_TASKS[task]?.chore || null
  }

  setDayPlan (plan) {
    this.dayPlan = plan
    this.store.setState(`day_plan:${this.name}`, plan)
    if (plan?.task) this.store.updateAgent(this.name, { current_goal: (plan.with ? `${this.society.displayName(plan.with)}と` : '') + DAY_TASKS[plan.task].ja })
  }

  // 今の行動をすぐ止める (会議・寝る時間・頼みごとなど)
  interruptAction () {
    this.interruptFlag = true
    try { this.body?.requestInterrupt(); this.bot?.pathfinder?.stop() } catch {}
  }

  async _choreOnce () {
    const chore = this._pickChore()
    if (!chore) { await sleep(800); return null }
    return this._runChore(chore)
  }

  async _runChore (chore) {
    log.info(this.name, `🔨 自分の仕事: ${chore.name} ${JSON.stringify(chore.args || {})}`)
    const ok = await this._execute(chore, 'chore')
    // 失敗した・無かった仕事はしばらく選ばない (考えが変わって切り上げただけなら除く)
    const r = this.lastResult || ''
    if (chore.key && !this._choreCut && (ok === false || /ない|なかった|無い/.test(r))) this._choreBan[chore.key] = Date.now() + 3 * 60000
    this._choreCut = false
    if (chore.after) await chore.after().catch(() => {})
    return ok
  }

  async _workUntil (decisionPromise) {
    let done = false; let value; let error
    decisionPromise.then(v => { done = true; value = v }, e => { done = true; error = e })
    while (!done && this.running && !this.pendingAction) {
      const chore = this._pickChore()
      if (!chore) { await Promise.race([decisionPromise.catch(() => {}), sleep(800)]); continue }
      const run = this._runChore(chore)
      await Promise.race([run, decisionPromise.catch(() => {})])
      if (done && this.busy) {
        // 考えがまとまった。基本は今の仕事を最後までやってから、考えたことをする (細切れにしない)。
        // 人のそばへ行く・渡す・戦う・逃げる・寝る など、すぐやるべきことなら切り上げる
        const plan = Array.isArray(value?.actions) && value.actions.length ? value.actions : [value?.action].filter(Boolean)
        if (plan[0]?.name === chore.name) { if (Array.isArray(value.actions)) value.actions = value.actions.slice(1); else value.action = null } else if (plan.some(a => URGENT_ACTIONS.has(a?.name))) {
          this._choreCut = true
          this.interruptFlag = true
          try { this.body?.requestInterrupt(); this.bot.pathfinder.stop() } catch {}
        }
      }
      await run
    }
    if (error) throw error
    return value
  }

  // 仲間へのおすそ分け: 近くの仲間が食べ物を持っていない、素材が全然ない、なら自分の余りを渡す
  _giftChore (s) {
    if (this.cfg.agent?.gifts === false) return null
    const now = Date.now()
    if (now - (this._lastGift || 0) < 90000) return null
    const mine = name => s.inventory.filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
    for (const p of s.players.filter(p => p.isAgent && p.dist <= 16)) {
      const other = this.society.agents.get(p.name)
      const inv = other?.bot?.inventory?.items?.() || []
      const has = re => inv.filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)
      let item = null; let n = 0
      const food = s.inventory.find(i => /^(bread|cooked_|baked_potato|apple|carrot)/.test(i.name))
      if (food && mine(food.name) >= 8 && has(/^(bread|cooked_|baked_potato|apple|carrot|beef|porkchop|chicken|mutton)/) === 0) { item = food.name; n = 4 }
      else if (has(/_log$|_planks$/) < 4) { const log = s.inventory.find(i => /_log$/.test(i.name) && i.count >= 20); if (log) { item = log.name; n = 8 } }
      else if (has(/^(cobblestone|stone)$/) < 4 && mine('cobblestone') >= 40) { item = 'cobblestone'; n = 16 }
      if (!item) continue
      this._lastGift = now
      const to = p.name
      return {
        name: 'give', args: { to, item, count: n }, key: 'gift:' + to,
        after: async () => {
          if (this.lastResult?.includes('渡した')) {
            const line = this.character.lines?.gift
            if (line?.length) await this.say(line[Math.floor(Math.random() * line.length)].replace('{name}', this.society.displayName(to)), to)
          }
        }
      }
    }
    return null
  }

  _recentChatText (n = 6) {
    return this.heard.slice(-n).map(h => `- ${h.fromDisplay}「${h.text}」`).join('\n')
  }

  async _decide () {
    const s = this.state()
    const stateText = describeState(s)
    const row = this.store.getAgent(this.name)
    const projects = this.society.describeProjects()
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
      experience: this.experience.text(5),
      // 今ワールドにいる人だけ (いない仲間の名前を出すと、探しに行って迷う)
      names: Object.keys(this.bot.players || {}).filter(n => n !== this.name).map(n => `${n}(${this.society.displayName(n)})`)
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
    // 独り言・話しかけは控えめに: プレイヤーとの会話中は話さない、1人あたり一定間隔をあける
    const gap = (this.cfg.agent?.spontaneous_say_interval_sec ?? 60) * 1000
    // 独り言は口調が違えば手直しし、それでもダメなら言わない (言い直しでLLMを使うほどではない)
    if (d.say) { const f = fixVoice(this.character, d.say); d.say = voiceIssues(this.character, f).length ? null : f }
    if (d.say && !this.society.conversation.humanThreadActive() && Date.now() - (this.lastSpontaneous || 0) > gap) {
      this.lastSpontaneous = Date.now()
      await this.say(d.say, d.say_to || null)
    }
    // 行動は最大3つまでまとめて計画できる (LLMを毎回呼ばずに動き続けるため)
    const plan = (Array.isArray(d.actions) && d.actions.length ? d.actions : [d.action]).filter(x => x && x.name && DECIDE_ACTIONS.includes(x.name)).slice(0, 3)
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
      if (this.body) {
        // 体の上で実行 (モードの反射と順番待ち・割り込みを共有する)
        const r = await this.body.run(`action:${a.name}`, () => def.run(this._ctx(), a.args || {}), { timeout: timeout / 60000 })
        if (!r.success) throw r.error || new Error('失敗')
        result = typeof r.value === 'string' ? r.value : (r.value === false ? `${a.name}できなかった` : `${a.name}をした`)
      } else result = await withTimeout(def.run(this._ctx(), a.args || {}), timeout, a.name)
    } catch (e) {
      ok = false
      result = `${a.name}に失敗: ${e.message.slice(0, 100)}`
      try { this.bot.pathfinder.stop() } catch {}
    } finally {
      this.busy = false
      this.currentAction = null
    }
    if (this.interruptFlag) result += this._choreCut ? ' (別のことをするので切り上げた)' : ' (緊急事態で中断)'
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
    return { bot: this.bot, agent: this, body: this.body, store: this.store, interrupted: () => this.interrupted() || !!this.bot?.interrupt_code }
  }

  // ------------------------------------------------------------------ 家・建築
  // みんなの家に住む: 自分のベッド・家 (家の中) を決める。自分で家を建てる仕事はしない
  moveIntoVillage (village) {
    if (!village) return
    this.village = village
    const bed = village.beds?.[this.name]
    if (bed) { this.bedPos = bed; this.store.setState(`bed:${this.name}`, bed) }
    if (!this.home || this.home.x !== village.center.x || this.home.z !== village.center.z) {
      this.home = village.center
      this.store.updateAgent(this.name, { home: village.center })
    }
    this.store.setState(`build:${this.name}:house`, 70) // 家はもうある
    this.houseSite = null
  }

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
  async say (text, to = null, { voicePriority = 1, shout = null, noReply = false } = {}) {
    text = String(text || '').trim()
    // 小さいモデルが指示文をそのまま書き写したものは話さない
    if (/字以内|JSON|その場で口にする|返事をJSON|^\(.*\)$|null$/.test(text)) { log.debug(this.name, '指示文の書き写しを除外: ' + text); return }
    if (!text || !this.bot) return
    text = text.replace(/^[/\\]+/, '') // 住人の発言がコマンドとして実行されないように
    text = cleanSpeech(text)
    // 英語のID (Kiritan) は日本語の名前に。考えごとの言葉 (短期目標を設定する 等) が混ざった文は削る
    for (const [u, c] of this.society.characters) text = text.split(u).join(c.display_name)
    const pn = this.cfg.player?.name
    if (pn) text = text.split(pn).join(this.society.displayName(pn))
    text = dropMetaTalk(text)
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
    this.society.bus.emit('say', { id, from: this.name, to, text, pos, shout, noReply })
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
    // 最期のひとことなど、返事をする場面ではない言葉は聞いて覚えるだけ (反応は「倒れたのを見た」側で)
    if (msg.noReply) {
      this.heard.push({ from: msg.from, fromDisplay: this.society.displayName(msg.from), text: msg.text, t: Date.now() })
      this.heard = this.heard.slice(-20)
      return
    }
    this._hear({ id: msg.id, from: msg.from, fromIsBot: true, text: msg.text, addressed, distance })
  }

  _onGameChat (username, message) {
    if (username === this.name || this.society.isAgent(username)) return // AIの発言はバスで受け取る
    // 「設定」と言ったら設定の本をもう一度渡す (住人は返事しない)。同じ発言が全員に届くので1回だけ
    if (username === this.cfg.player?.name && /^(設定|せってい|設定の本)$/.test(String(message).trim())) {
      if (Date.now() - (this.society._bookAt || 0) > 3000) { this.society._bookAt = Date.now(); this.society.settings?.giveBook() }
      return
    }
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
      stateText: describeState(s).split('\n').slice(0, 5).join('\n'), // 時間・体力・位置・持ち物・近くの人 (「鉄ある？」に正直に答えられるように)
      sightings: this.sightingsText(),
      experience: this.experience.text(4),
      thread,
      stance,
      why,
      isGroup,
      others
    })
    const prio = llmPriority ?? (isHuman ? PRIORITY.HUMAN : PRIORITY.CHAT)
    const r = await this.society.llm.requestJson(messages, { priority: prio, tag: `${this.name}:reply` })
    if (r.say) r.say = await this._inVoice(r.say, messages, prio)
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
    // 頼みごとは言葉から確実に読み取る (小さいAIは引き受けると言っても action を書き忘れる)
    if (isHuman) {
      const req = requestFromText(text, { from, hasHome: !!this.home })
      if (req) {
        if (req.focus) { this.focus = { kind: req.focus, until: Date.now() + 10 * 60000 }; log.info(this.name, `📌 ${speakerDisplay}に頼まれた: ${req.focus}`) }
        if (req.action) r.action = req.action
      }
    }
    const allowed = isHuman ? REQUEST_ACTIONS : ['go_to_player', 'follow', 'give', 'rest']
    if (r.action?.name && allowed.includes(r.action.name) && !this.pendingAction?.reflex) {
      this.pendingAction = { name: r.action.name, args: r.action.args || {} }
      if (isHuman) this.memory.add('goal', `${speakerDisplay}に頼まれて${r.action.name}をすることにした`, { importance: 4, about: from, day })
      if (this.busy) { this.interruptFlag = true; try { this.body?.requestInterrupt(); this.bot.pathfinder.stop() } catch {} } // 頼みごとを優先
    }
    return r
  }

  // 口調がこのキャラのもの (一人称・語尾) か確かめて、違えば1回だけ言い直させる
  async _inVoice (text, messages, priority) {
    let issues = voiceIssues(this.character, text)
    if (!issues.length) return text
    log.info(this.name, `🎭 口調が違うので言い直し: ${text} (${issues.join(' / ')})`)
    try {
      const r = await this.society.llm.requestJson([...messages,
        { role: 'assistant', content: JSON.stringify({ say: text }) },
        { role: 'user', content: `今のセリフは${this.display}の口調になっていない: ${issues.join('、')}。\n${this.character.speech}\n同じ内容を${this.display}の口調で言い直して。JSON {"say":"..."} だけで答える。` }
      ], { priority, tag: `${this.name}:voicefix`, temperature: 0.6 })
      if (r.say) text = String(r.say)
    } catch {}
    issues = voiceIssues(this.character, text)
    return issues.length ? fixVoice(this.character, text) : text
  }

  _makePromise (to, content) {
    const target = this._resolveAliases([to])[0] || to
    // 約束は1つずつ。「約束を立てる約束」のような中身のない約束はしない
    if (/約束|会議/.test(content)) return
    if (this.store.get("SELECT id FROM promises WHERE agent = ? AND status = 'open'", this.name)) return
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
    // 最期のひとこと: 倒れる瞬間に (近くの人には聞こえる。叫びなので遠くまで届く)
    const lastWords = this.cfg.death?.last_words === false ? null : await this._lastWords().catch(() => null)
    await sleep(600)
    const m = this.lastDeathMsg && Date.now() - this.lastDeathMsg.t < 8000 ? this.lastDeathMsg.msg : null
    const rawCause = m ? m.replace(this.name, '').trim() : ''
    const cause = causeJa(rawCause)
    const day = this.day()
    const permanent = !!this.cfg.death?.permanent
    this.store.run('INSERT INTO deaths (agent, cause, x, y, z, dimension, day, permanent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      this.name, cause, p?.x ?? null, p?.y ?? null, p?.z ?? null, this.bot.game?.dimension || null, day, permanent ? 1 : 0, Date.now())
    const row = this.store.getAgent(this.name)
    const caution = Math.min(6, (row.caution || 0) + 1)
    this.store.updateAgent(this.name, { deaths: (row.deaths || 0) + 1, caution })
    this.safety.setCaution(caution)
    const lesson = Safety.lessonFromDeath(rawCause)
    this.experience.add('died', { cause, pos: p, lastWords })
    const n = this.experience.myDeaths().length
    this.memory.add('death', `${day}日目に${relativePlace(p, this.village?.center || this.home)}で${cause}のせいで倒れた${lastWords ? ` (最期に「${lastWords}」と言った)` : ''}${n >= 2 ? ` 最近${n}回目` : ''}`, { importance: 9, day })
    this.memory.add('lesson', lesson, { importance: 8, day })
    log.warn(this.name, `☠ 死亡: ${cause} → 教訓「${lesson}」 慎重さ${caution}${n >= 2 ? ` (最近${n}回目)` : ''}`)
    this._justDied = { cause, pos: p, day }
    this.interruptFlag = true
    if (permanent) {
      this.alive = false
      this.store.updateAgent(this.name, { alive: 0 })
      this.society.shared.add('memorial', `${this.display}の家と持ち物はそのまま残されている`, { importance: 6, participants: [this.name], day })
      setTimeout(() => this.stop(), 3000)
    }
    this.society.onAgentDeath(this.name, { cause, pos: p, day, permanent, lastWords }).catch(e => log.warn('society', e.message))
  }

  // 倒れる瞬間のひとこと。AIが遅いときは用意したセリフで (倒れてから何秒も後に言うと不自然)
  async _lastWords () {
    const bot = this.bot
    const hostiles = Object.values(bot.entities || {}).filter(e => e.type === 'hostile' && e.position && bot.entity && e.position.distanceTo(bot.entity.position) < 12).map(e => causeJa('by ' + e.name).replace(/の攻撃$/, ''))
    const hurt = this.experience.recent('hurt', 15000).pop()
    const situation = [
      hostiles.length ? `${[...new Set(hostiles)].join('・')}に囲まれている` : '',
      bot.entity?.isInWater ? '水の中で息が続かない' : '',
      bot.entity?.isInLava ? '溶岩の中' : '',
      hurt ? `${hurt.by}にやられた` : '',
      bot.food === 0 ? 'お腹がすきすぎた' : ''
    ].filter(Boolean).join('、') || '体力が尽きた'
    const nearby = this.state().players.filter(p => p.dist <= 16).map(p => this.society.displayName(p.name)).join('、')
    const fallback = (this.character.lines?.last_words || ['うっ…ここまで、か…', 'まだ…やれたのに…', 'あとは…たのんだ…'])
    const fresh = fallback.filter(t => t !== this._lastLastWords)
    let text = fresh[Math.floor(Math.random() * fresh.length)] || fallback[0]
    try {
      const messages = buildLastWordsPrompt({ character: this.character, agentRow: this.store.getAgent(this.name), situation, nearby })
      const r = await withTimeout(this.society.llm.requestJson(messages, { priority: PRIORITY.URGENT, tag: `${this.name}:last_words` }), 3500)
      if (r?.say) text = fixVoice(this.character, String(r.say).slice(0, 30))
    } catch {}
    text = text.replace(/[。.]$/, '')
    if (text === this._lastLastWords) text = fallback.find(t => t !== text) || text
    this._lastLastWords = text
    this._said = (this._said || []).filter(x => x.text !== text) // 最期の言葉は「繰り返し」扱いで消さない
    log.info(this.name, `🕯 最期のひとこと: ${text}`)
    await this.say(text, null, { shout: true, voicePriority: 3, noReply: true })
    return text
  }

  // 体力が減った: 近くの敵にやられたなら、どこで誰にやられたかを覚える
  _onHealth () {
    const bot = this.bot
    const h = bot.health
    const prev = this._prevHealth ?? h
    this._prevHealth = h
    if (!(h < prev) || !bot.entity) return
    const foe = Object.values(bot.entities || {}).filter(e => e.type === 'hostile' && e.position && e.position.distanceTo(bot.entity.position) < 6)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (foe) this.experience.hurt(causeJa('by ' + foe.name).replace(/の攻撃$/, ''), bot.entity.position)
  }

  // 家のベッドで目を覚ました (復活)
  async _onRespawn ({ cause }) {
    if (!this.bot?.entity) return
    const n = this.experience.myDeaths().length
    this.memory.add('event', `${cause}で倒れて、家で目を覚ました`, { importance: 4, day: this.day() })
    if (this.cfg.death?.respawn_talk === false) return
    const near = this.state().players.filter(p => p.dist <= 16).map(p => this.society.displayName(p.name))
    // 誰もいないときは、ひとりごとを言う気分のときだけ
    if (!near.length && Math.random() < 0.5) return
    try {
      const messages = buildRespawnPrompt({ character: this.character, agentRow: this.store.getAgent(this.name), cause, count: n, nearby: near.join('、'), experience: this.experience.text(4) })
      const r = await this.society.llm.requestJson(messages, { priority: PRIORITY.CHAT, tag: `${this.name}:respawn` })
      if (r.lesson) this.memory.add('lesson', String(r.lesson).slice(0, 40), { importance: 7, day: this.day() })
      if (r.say) await this.say(await this._inVoice(String(r.say), messages, PRIORITY.CHAT))
    } catch (e) { log.debug(this.name, '目覚めの一言を作れなかった: ' + e.message) }
  }

  // 仲間が倒れたのを見た / 悲鳴を聞いた (復活する世界)。覚えて、性格どおりに反応する
  async _witnessDeath (dead, { cause, how, day, lastWords, pos: deadPos }) {
    const d = this.society.displayName(dead)
    this.experience.add(how === 'saw' ? 'saw_death' : 'heard_scream', { who: dead, cause: how === 'saw' ? cause : null, lastWords: how === 'saw' ? lastWords : null, pos: how === 'saw' ? deadPos : null })
    const count = this.experience.knownDeathsOf(dead)
    this.memory.add('event', how === 'saw'
      ? `${d}が${cause}で倒れるのを見た${lastWords ? ` (最期に「${lastWords}」と言っていた)` : ''}${count >= 2 ? ` 最近${count}回目` : ''}`
      : `どこかで${d}の悲鳴が聞こえた`, { importance: count >= 3 ? 6 : 4, about: dead, day })
    if (this.cfg.death?.witness_react === false) return null
    // 悲鳴は、親しい相手か、何度も続いているときだけ口に出す
    const rel = this.society.relations.get(this.name, dead)
    const closeness = rel ? (rel.affinity + rel.trust) / 2 : 0
    if (how !== 'saw' && closeness < 45 && count < 2) return null
    if (Date.now() - (this._lastWitnessTalk || 0) < 30000) return null
    this._lastWitnessTalk = Date.now()
    await sleep(1200 + Math.random() * 2500) // 最期の言葉の後に、少し間を置いて
    try {
      const messages = buildWitnessPrompt({ character: this.character, agentRow: this.store.getAgent(this.name), deadDisplay: d, how, cause, lastWords, count, relationText: this.society.relations.describe(this.name, [dead]), experience: this.experience.text(4) })
      const r = await this.society.llm.requestJson(messages, { priority: PRIORITY.URGENT, tag: `${this.name}:witness` })
      if (r.feeling) this.memory.add('reflection', `${d}が倒れたことについて: ${r.feeling}`, { importance: 5, about: dead, day })
      if (r.say) await this.say(await this._inVoice(String(r.say), messages, PRIORITY.URGENT), dead)
      // 悲鳴を聞いて、親しい相手なら様子を見に行く
      if (how !== 'saw' && r.go_help && closeness >= 45 && !this.pendingAction) this.pendingAction = { name: 'go_to_player', args: { name: dead }, reflex: true }
      return r
    } catch { return null }
  }

  async reactToDeath (dead, { cause, permanent, day, how = 'saw', lastWords = null, pos = null }) {
    if (!this.alive) return null
    if (!permanent && !this.cfg.death?.react_on_respawn) return this._witnessDeath(dead, { cause, how, day, lastWords, pos })
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
    if (r.say) await this.say(fixVoice(this.character, r.say), null)
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

// 「短期目標を設定する」「約束をする」のような、考えている内容(計画の言葉)をそのまま口にした文を取り除く
const META = /(短期目標|長期目標|目標を(設定|更新|立て)|約束をする(の|こと)|行動(を|は)(選|決)|JSON|say|action|goal)/i
export function dropMetaTalk (text) {
  const parts = String(text || '').split(/(?<=[。！？!?])/)
  const kept = parts.filter(p => !META.test(p))
  return kept.join('').trim()
}

// 人間がこちらを見ているか (視線の向きと、相手→自分の向きの角度が小さい)
export function lookingAt (entity, targetPos) {
  const y = entity.yaw || 0; const p = entity.pitch || 0
  const dir = { x: -Math.sin(y) * Math.cos(p), y: Math.sin(p), z: -Math.cos(y) * Math.cos(p) }
  const eye = entity.position.offset ? entity.position.offset(0, 1.62, 0) : { x: entity.position.x, y: entity.position.y + 1.62, z: entity.position.z }
  const v = { x: targetPos.x - eye.x, y: targetPos.y + 1.5 - eye.y, z: targetPos.z - eye.z }
  const len = Math.hypot(v.x, v.y, v.z) || 1
  const cos = (dir.x * v.x + dir.y * v.y + dir.z * v.z) / len
  return cos > 0.985 // 約10度以内
}

// 今の仕事を切り上げてでも、すぐやるべき行動
const URGENT_ACTIONS = new Set(['go_to_player', 'follow', 'give', 'attack', 'flee', 'sleep', 'eat', 'go_home', 'escape_hazard'])

const MODE_JA = { self_preservation: '身の危険', unstuck: 'はまった', self_defense: '敵への反撃', item_collecting: '落ちている物拾い', torch_placing: '松明置き', elbow_room: '場所をあける', cowardice: '逃げる', hunting: '狩り' }

