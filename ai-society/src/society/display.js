// ゲーム内の見た目: 頭上の名前 (日本語・イメージカラー) と吹き出し、チャット表示。
// サーバーのコマンド (text_display / tellraw / team) で表示する。
// コマンドは起動役 (launch.js) がサーバーの操作画面に流す。住人ボット自身にOP権限は渡さない。
import { log } from '../util/log.js'

// LLM の文章をコマンドに入れても壊れない・悪用されないように整える
export function cleanText (s, max = 120) {
  return String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').replace(/§/g, '').slice(0, max)
}

function versionAtLeast (v, target) {
  const a = String(v || '').split('.').map(Number); const b = target.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return true
}

// text_display の text 項目: 1.21.4 までは JSON 文字列、1.21.5 以降は SNBT の部品
export function textNbt (component, version) {
  const json = JSON.stringify(component)
  if (versionAtLeast(version, '1.21.5')) return json
  return "'" + json.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

// '#RRGGBB' → 半透明の背景色 (ARGB の符号付き32bit整数)
export function argb (hex, alpha = 0xC0) {
  const rgb = parseInt(String(hex || '#3060C0').replace('#', ''), 16) & 0xffffff
  return ((alpha << 24) | rgb) | 0
}

const TRANSFORM = y => `transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,${y}f,0f],scale:[1f,1f,1f]}`

export class WorldDisplay {
  constructor (cfg = {}) {
    this.enabled = !!cfg.enabled
    this.version = cfg.version || '1.21.4'
    this.nameY = cfg.name_offset ?? 0.25
    this.bubbleY = cfg.bubble_offset ?? 0.55
    this.timers = new Map()
    this.send = cmd => console.log('@@CMD ' + cmd)
  }

  sel (name, kind) { return `@e[type=text_display,tag=ais_${name},tag=ais_${kind},limit=1]` }

  setupTeam (names) {
    if (!this.enabled) return
    this.send('kill @e[type=text_display,tag=ais]') // 前回の残り
    this.send('team add ais')
    this.send('team modify ais nametagVisibility never') // 英語のIDを頭上に出さない
    for (const n of names) this.send(`team join ais ${n}`)
  }

  // 住人がスポーン/リスポーンしたら、頭上に名前と(空の)吹き出しを乗せる
  attach (c) {
    if (!this.enabled) return
    const n = c.username
    this.send(`kill @e[type=text_display,tag=ais_${n}]`)
    const name = textNbt({ text: c.display_name, color: c.color || '#FFFFFF', bold: true }, this.version)
    // 頭上への追従は、サーバーに入れたデータパック (毎tick tp) が行う。teleport_duration でなめらかに動く
    this.send(`execute at ${n} run summon text_display ~ ~1.9 ~ {Tags:["ais","ais_${n}","ais_name"],billboard:"center",shadow:1b,line_width:200,teleport_duration:2,background:${argb('#000000', 0x40)},text:${name},${TRANSFORM(this.nameY)}}`)
    this.send(`execute at ${n} run summon text_display ~ ~1.9 ~ {Tags:["ais","ais_${n}","ais_bubble"],billboard:"center",shadow:0b,line_width:220,teleport_duration:2,background:0,text:${textNbt({ text: '' }, this.version)},${TRANSFORM(this.bubbleY)}}`)
  }

  detach (c) {
    if (!this.enabled) return
    this.send(`kill @e[type=text_display,tag=ais_${c.username}]`)
  }

  // 吹き出しに発言を出して、しばらくしたら消す
  bubble (c, text) {
    if (!this.enabled) return
    const n = c.username
    const t = cleanText(text, 80)
    const comp = textNbt({ text: t, color: '#FFFFFF', bold: true }, this.version)
    this.send(`data merge entity ${this.sel(n, 'bubble')} {text:${comp},background:${argb(c.color, 0xD0)}}`)
    clearTimeout(this.timers.get(n))
    const ms = Math.min(12000, 3000 + t.length * 150)
    this.timers.set(n, setTimeout(() => {
      this.send(`data merge entity ${this.sel(n, 'bubble')} {text:${textNbt({ text: '' }, this.version)},background:0}`)
    }, ms))
  }

  // チャット欄: <日本語の名前(色付き)> 発言
  chat (c, text) {
    const comp = [{ text: '<' }, { text: c.display_name, color: c.color || '#FFFFFF' }, { text: '> ' + cleanText(text, 200) }]
    this.send(`tellraw @a ${JSON.stringify(comp)}`)
  }
}

export function makeDisplay (cfg) {
  const d = new WorldDisplay({ enabled: !!process.env.AI_SOCIETY_LAUNCHED && cfg.display?.enabled !== false, version: cfg.minecraft?.version, ...(cfg.display || {}) })
  if (d.enabled) log.info('display', '頭上の名前・吹き出し・日本語チャットを有効にした')
  return d
}

// 頭上表示を住人に追従させるデータパック (server/world/datapacks/ais) の中身
export function datapackFiles (names, packFormat = 61) {
  const tick = names.map(n => `execute as ${n} at @s run tp @e[type=text_display,tag=ais_${n}] ~ ~1.9 ~`).join('\n') + '\n'
  return {
    'pack.mcmeta': JSON.stringify({ pack: { pack_format: packFormat, supported_formats: [packFormat, 99], description: 'AI Society: 住人の頭上表示' } }, null, 2),
    'data/ais/function/tick.mcfunction': tick,
    'data/minecraft/tags/function/tick.json': JSON.stringify({ values: ['ais:tick'] })
  }
}
