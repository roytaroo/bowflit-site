// 住人の「体」: 行動を1つずつ実行し (割り込み可)、その裏で「モード」(反射の動き) を毎tick回す。
// 行動の中身は Mindcraft のスキル (skills.js) を使う。考える(LLM)のは別の場所で、ここは体を動かすだけ。
import { setupBot, setVersion } from './mcdata.js'
import { initModes } from './modes.js'

// 最初から有効にするモード。cowardice (敵を見たら逃げる) は、戦えるときも逃げてしまうので切っておく
export const DEFAULT_MODES = {
  self_preservation: true, // 溺れる・燃える・瀕死 → 逃げる
  unstuck: true, // 同じ場所で動けない → 抜け出す
  cowardice: false,
  self_defense: true, // 近くの敵に反撃
  hunting: false, // 動物を勝手に狩る (村の動物を狩り尽くすので切る)
  item_collecting: true, // 近くに落ちている物を拾う
  torch_placing: true, // 暗い所に松明を置く
  elbow_room: true, // 人と重ならないよう少しどく
  idle_staring: true, // 暇なときに周りを見る
  cheat: false
}

class ActionManager {
  constructor (body) {
    this.body = body
    this.executing = false
    this.currentActionLabel = ''
    this.timedout = false
  }

  async stop () {
    if (!this.executing) return
    const end = Date.now() + 10000
    while (this.executing && Date.now() < end) {
      this.body.requestInterrupt()
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  // 行動を1つ実行する。実行中の行動があれば止めてから。timeout は分
  async runAction (label, fn, { timeout = -1 } = {}) {
    const bot = this.body.bot
    await this.stop()
    this.body.clearBotLogs()
    this.executing = true
    this.currentActionLabel = label
    this.timedout = false
    let timer = null
    if (timeout > 0) timer = setTimeout(() => { this.timedout = true; this.body.requestInterrupt() }, timeout * 60000)
    try {
      const value = await fn()
      return { success: true, value, message: bot.output, interrupted: !!bot.interrupt_code, timedout: this.timedout }
    } catch (err) {
      return { success: false, error: err, message: bot.output + `(エラー: ${err?.message || err})`, interrupted: !!bot.interrupt_code, timedout: this.timedout }
    } finally {
      clearTimeout(timer)
      this.executing = false
      this.currentActionLabel = ''
      if (!bot.interrupt_code) bot.emit('idle')
    }
  }
}

export class Body {
  constructor (bot, { modes = {}, onModeSay = null, onModeFinished = null, tickMs = 300 } = {}) {
    this.bot = bot
    bot.output = ''
    bot.interrupt_code = false
    if (bot.version) setVersion(bot.version)
    this.actions = new ActionManager(this)
    this.onModeSay = onModeSay
    this.onModeFinished = onModeFinished
    initModes(this, { ...DEFAULT_MODES, ...modes })
    this._timer = setInterval(() => this._tick(), tickMs)
  }

  // プラグインと Paper 対策を付ける (ボット作成直後、spawn より前に呼ぶ)
  static prepare (bot, opts) { return setupBot(bot, opts) }

  isIdle () { return !this.actions.executing }

  requestInterrupt () {
    const bot = this.bot
    bot.interrupt_code = true
    try { bot.stopDigging() } catch {}
    try { bot.collectBlock?.cancelTask() } catch {}
    try { bot.pathfinder?.stop(); bot.pathfinder?.setGoal(null) } catch {}
    try { bot.pvp?.stop() } catch {}
  }

  clearBotLogs () {
    this.bot.output = ''
    this.bot.interrupt_code = false
  }

  // 行動を実行 (モードと同じ順番待ち・割り込みの仕組みに乗る)
  run (label, fn, opts) { return this.actions.runAction(label, fn, opts) }

  async _tick () {
    if (this._ticking || !this.bot.entity) return
    this._ticking = true
    try { await this.bot.modes.update() } catch {} finally { this._ticking = false }
  }

  stop () { clearInterval(this._timer) }
}
