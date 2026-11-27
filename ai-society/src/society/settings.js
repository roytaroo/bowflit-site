// だいき専用の「村の設定」の本。ゲームの中で本を開いて、ボタンを押すとON/OFFやバー(段階)が変わる。
// しくみ: 本のボタンを押すと、だいきから住人へ「#set 名前 値」というささやき (/msg) が送られる。
// 住人側のプログラムがそれを受け取って設定を変え、保存し、新しい値を書いた本に取り替える。
// 他のプレイヤーからのささやきは無視する (だいきだけが変えられる)。
import { log } from '../util/log.js'

const MODE = name => ({
  get: (cfg) => (cfg.agent?.modes?.[name] ?? DEFAULT_MODES[name]) !== false,
  set: (cfg, on, agents) => {
    cfg.agent = cfg.agent || {}
    cfg.agent.modes = { ...(cfg.agent.modes || {}), [name]: on }
    for (const a of agents) { try { a.bot?.modes?.setOn(name, on) } catch {} }
  }
})
const DEFAULT_MODES = { hunting: false, torch_placing: true, item_collecting: true, self_defense: true }

// path: 設定ファイルの場所 ('meeting.enabled' など)。def: 何も書いていないときの値
export const SETTINGS = [
  { key: 'meeting', label: '朝の会議', type: 'toggle', path: 'meeting.enabled', def: true },
  { key: 'sleep', label: '夜は家で寝る', type: 'toggle', path: 'world.auto_sleep', def: true },
  { key: 'rescue', label: '迷子を家に送る', type: 'toggle', path: 'village.rescue_tp', def: true },
  { key: 'work', label: '自分で仕事する', type: 'toggle', path: 'agent.auto_work', def: true },
  { key: 'gifts', label: '仲間に物を配る', type: 'toggle', path: 'agent.gifts', def: true },
  { key: 'greet', label: 'あいさつ・おじぎ', type: 'toggle', path: 'agent.greetings', def: true },
  { key: 'lastwords', label: '最期のひとこと', type: 'toggle', path: 'death.last_words', def: true },
  { key: 'witness', label: '倒れた仲間に反応', type: 'toggle', path: 'death.witness_react', def: true },
  { key: 'respawn', label: '起きた時のひとこと', type: 'toggle', path: 'death.respawn_talk', def: true },
  { key: 'hunt', label: '動物を狩る', type: 'toggle', ...MODE('hunting') },
  { key: 'torch', label: '松明を置く', type: 'toggle', ...MODE('torch_placing') },
  { key: 'pickup', label: '落ちた物を拾う', type: 'toggle', ...MODE('item_collecting') },
  { key: 'fight', label: '敵に反撃する', type: 'toggle', ...MODE('self_defense') },
  { key: 'think', label: '考える間隔', type: 'bar', path: 'agent.decide_interval_ms', values: [5000, 10000, 15000, 20000, 30000, 45000, 60000], show: v => `${v / 1000}秒`, def: 15000 },
  {
    key: 'chatty',
    label: 'おしゃべりの多さ',
    type: 'bar',
    values: [0, 1, 2, 3, 4, 5],
    show: v => ['無口', 'ひかえめ', '少なめ', 'ふつう', '多め', 'にぎやか'][v],
    get: cfg => {
      const n = cfg.conversation?.max_bot_messages_per_min ?? 6
      return [0, 2, 4, 6, 9, 12].reduce((best, x, i) => Math.abs(x - n) < Math.abs([0, 2, 4, 6, 9, 12][best] - n) ? i : best, 3)
    },
    set: (cfg, v) => {
      cfg.conversation = cfg.conversation || {}
      cfg.agent = cfg.agent || {}
      cfg.conversation.max_bot_messages_per_min = [0, 2, 4, 6, 9, 12][v]
      cfg.agent.spontaneous_say_interval_sec = [1e9, 400, 240, 120, 80, 50][v]
      cfg.conversation.max_bot_exchanges = [0, 2, 3, 4, 6, 8][v]
    }
  },
  { key: 'hear', label: '声の届く距離', type: 'bar', path: 'conversation.hearing_range', values: [8, 12, 16, 24, 32], show: v => `${v}ブロック`, def: 16 },
  { key: 'flee', label: '逃げ出す体力', type: 'bar', path: 'safety.flee_health', values: [2, 4, 6, 8, 10, 12], show: v => `ハート${v / 2}`, def: 8 },
  {
    key: 'budget',
    label: '1日のAI予算',
    type: 'bar',
    values: [20, 50, 100, 200, 300, 500],
    show: v => `${v}円`,
    only: s => !!s.llm?.budget, // 有料AIのときだけ
    get: (cfg, s) => s.llm?.budget?.limitYen ?? cfg.llm?.daily_budget_yen ?? 100,
    set: (cfg, v, agents, s) => { cfg.llm.daily_budget_yen = v; if (s.llm?.budget) s.llm.budget.limitYen = v }
  }
]

function getPath (obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj) }
function setPath (obj, path, v) {
  const ks = path.split('.'); const last = ks.pop()
  let o = obj
  for (const k of ks) { o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}; o = o[k] }
  o[last] = v
}

export class LiveSettings {
  constructor ({ society, cfg, store, send, agents, llm }) {
    this.society = society
    this.cfg = cfg
    this.store = store
    this.send = send
    this.agents = agents
    this.llm = llm
    this.player = cfg.player?.name
  }

  _ctx () { return { llm: this.llm } }
  _list () { return SETTINGS.filter(d => !d.only || d.only(this._ctx())) }

  value (d) {
    if (d.get) return d.get(this.cfg, this._ctx())
    const v = getPath(this.cfg, d.path)
    return v ?? d.def
  }

  _apply (d, v) {
    if (d.set) d.set(this.cfg, v, this.agents, this._ctx())
    else setPath(this.cfg, d.path, v)
  }

  // 前回変えた設定を、起動時に戻す
  load () {
    const saved = this.store.getState('live_settings', {}) || {}
    for (const d of SETTINGS) if (d.key in saved) { try { this._apply(d, saved[d.key]) } catch {} }
    if (Object.keys(saved).length) log.info('settings', `設定の本で変えた設定を戻した: ${Object.entries(saved).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }

  // 「#set key 値」を受け取った
  handle (from, message) {
    if (from !== this.player) return false
    const m = String(message).trim().match(/^#set (\w+) (\S+)$/)
    if (!m) return false
    const d = SETTINGS.find(x => x.key === m[1])
    if (!d) return true
    let v
    if (d.type === 'toggle') v = m[2] === '1' || m[2] === 'on'
    else { v = d.values[Number(m[2])]; if (v === undefined) return true }
    this._apply(d, v)
    const saved = this.store.getState('live_settings', {}) || {}
    saved[d.key] = v
    this.store.setState('live_settings', saved)
    const shown = d.type === 'toggle' ? (v ? 'ON' : 'OFF') : d.show(v)
    log.info('settings', `だいきが設定を変えた: ${d.label} → ${shown}`)
    this.send(`tellraw ${this.player} ${JSON.stringify({ text: `⚙ ${d.label}: ${shown}`, color: 'gold' })}`)
    this.giveBook()
    return true
  }

  // ボタンを押したときのささやき先 (今ワールドにいる住人)
  _target () {
    const a = this.agents.find(x => x.ready?.() && x.bot?.entity)
    return a?.name || null
  }

  // 本の中身 (1.21.4 の書式: 各ページは JSON の文字列)
  pages () {
    const to = this._target()
    if (!to) return null
    const btn = (text, color, cmd, hover) => ({ text, color, bold: false, clickEvent: { action: 'run_command', value: `/msg ${to} ${cmd}` }, hoverEvent: { action: 'show_text', contents: hover } })
    const list = this._list()
    const toggles = list.filter(d => d.type === 'toggle')
    const bars = list.filter(d => d.type === 'bar')
    const pages = []
    pages.push([
      { text: '村の設定\n\n', bold: true, color: 'dark_green' },
      { text: '文字を押すと切り替わる。押したあと本を開き直すと、新しい値になってる。\n\n', color: 'black' },
      { text: 'ON/OFF: 2〜' + (1 + Math.ceil(toggles.length / 6)) + 'ページ\nバー: その後ろ\n\n', color: 'dark_gray' },
      { text: '本をなくしたら、チャットで「設定」と言えばまたもらえる', color: 'dark_gray' }
    ])
    for (let i = 0; i < toggles.length; i += 6) {
      const page = []
      for (const d of toggles.slice(i, i + 6)) {
        const on = !!this.value(d)
        page.push({ text: d.label + '\n', color: 'black' })
        page.push({ text: '  ' })
        page.push(on ? { text: '■ON', color: 'dark_green', bold: true } : btn('□ON', 'gray', `#set ${d.key} 1`, `${d.label}をONにする`))
        page.push({ text: '  ' })
        page.push(!on ? { text: '■OFF', color: 'red', bold: true } : btn('□OFF', 'gray', `#set ${d.key} 0`, `${d.label}をOFFにする`))
        page.push({ text: '\n' })
      }
      pages.push(page)
    }
    for (let i = 0; i < bars.length; i += 4) {
      const page = []
      for (const d of bars.slice(i, i + 4)) {
        const v = this.value(d)
        const idx = d.key === 'chatty' ? v : d.values.reduce((b, x, j) => Math.abs(x - v) < Math.abs(d.values[b] - v) ? j : b, 0)
        page.push({ text: `${d.label}: `, color: 'black' })
        page.push({ text: d.show(d.values[idx]) + '\n', color: 'dark_blue', bold: true })
        page.push({ text: ' ' })
        d.values.forEach((x, j) => page.push(j === idx
          ? { text: '■', color: 'dark_green' }
          : btn(j < idx ? '■' : '□', j < idx ? 'green' : 'gray', `#set ${d.key} ${j}`, `${d.label}を「${d.show(x)}」にする`)))
        page.push({ text: '\n\n' })
      }
      pages.push(page)
    }
    return pages
  }

  // 本を渡す (古い本は取り上げてから)
  giveBook () {
    if (!this.player) return false
    const pages = this.pages()
    if (!pages) return false
    const snbtStr = s => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
    const pageList = pages.map(p => snbtStr(JSON.stringify(['', ...p]))).join(',')
    this.send(`clear ${this.player} written_book[custom_data={ais_settings:1b}]`)
    this.send(`give ${this.player} written_book[written_book_content={title:"村の設定",author:"AI村",pages:[${pageList}]},custom_data={ais_settings:1b},lore=['{"text":"押すと住人の設定が変わる","color":"gray","italic":false}']] 1`)
    this.store.setState('settings_book_given', true)
    return true
  }
}
