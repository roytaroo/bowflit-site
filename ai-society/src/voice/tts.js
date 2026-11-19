// 音声合成と再生 (VOICEVOX ENGINE / ゆっくり=AquesTalk系の外部コマンド)。
// - キャラクターの voice.engine で切り替え
// - VOICEVOX は「話者名 + スタイル名」で指定し、起動時に /speakers からIDを引く (IDはバージョンで変わりうるため)
// - 再生キューは1本。優先度 (プレイヤーへの返事が先) と、混雑時の古い発言の破棄
// - isSpeaking() はマイクの自己音声の聞き取り防止 (常時会話モード) に使う
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { log, sleep } from '../util/log.js'

// コマンド文字列を引数に分割 (ダブルクォート対応)。シェルを通さないので本文に記号があっても安全
export function splitCommand (template) {
  const out = []; let cur = ''; let q = false; let has = false
  for (const ch of template) {
    if (ch === '"') { q = !q; has = true; continue }
    if (!q && /\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue }
    cur += ch
  }
  if (cur || has) out.push(cur)
  return out
}

export function fillCommand (template, vars) {
  return splitCommand(template).map(a => a.replace(/\{(\w+)\}/g, (_m, k) => vars[k] != null ? String(vars[k]) : ''))
}

// 読み上げ用にテキストを整える (絵文字・記号・URLを除く)
export function cleanForSpeech (text, max = 120) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[*_#`~<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export class TTS {
  constructor (cfg = {}) {
    this.enabled = !!cfg.enabled
    this.url = (cfg.url || 'http://127.0.0.1:50021').replace(/\/$/, '')
    this.outDir = cfg.out_dir || 'data/voice'
    this.gapMs = cfg.gap_ms ?? 300
    this.maxQueue = cfg.max_queue ?? 8
    this.maxChars = cfg.max_chars ?? 120
    this.player = cfg.player || null
    this.keepFiles = !!cfg.keep_files
    this.aques = { command: null, fallback_speaker_name: 'ずんだもん', ...(cfg.aquestalk || {}) }
    this.speakerIds = new Map() // "名前/スタイル" -> id
    this.queue = []
    this.playing = false
    this.speakingUntil = 0
    this.seq = 0
    this.synth = { voicevox: (t, v) => this._voicevox(t, v), aquestalk: (t, v) => this._aquestalk(t, v) }
    if (this.enabled) fs.mkdirSync(this.outDir, { recursive: true })
  }

  async check () {
    try {
      const r = await fetch(this.url + '/version')
      if (!r.ok) return null
      await this.loadSpeakers()
      return (await r.text()).replace(/"/g, '')
    } catch { return null }
  }

  async loadSpeakers () {
    const r = await fetch(this.url + '/speakers')
    if (!r.ok) throw new Error('VOICEVOX /speakers HTTP ' + r.status)
    const list = await r.json()
    this.speakerIds.clear()
    for (const sp of list) for (const st of sp.styles) this.speakerIds.set(`${norm(sp.name)}/${norm(st.name)}`, st.id)
    return list
  }

  resolveSpeaker (voice = {}) {
    if (voice.speaker != null) return voice.speaker
    const name = norm(voice.speaker_name || '')
    const style = norm(voice.style || 'ノーマル')
    if (this.speakerIds.has(`${name}/${style}`)) return this.speakerIds.get(`${name}/${style}`)
    for (const [k, id] of this.speakerIds) if (k.startsWith(name + '/')) return id // スタイル違いは最初のもの
    return null
  }

  async _voicevox (text, voice) {
    // voice.url を書けば、そのキャラだけ別のVOICEVOX互換エンジン (例: 自分の声を学習させた AivisSpeech) を使える
    const base = (voice.url || this.url).replace(/\/$/, '')
    const speaker = this.resolveSpeaker(voice)
    if (speaker == null) throw new Error(`VOICEVOXに話者「${voice.speaker_name}」が見つからない (npm run voices で確認)`)
    const q = await fetch(`${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: 'POST' })
    if (!q.ok) throw new Error('audio_query HTTP ' + q.status)
    const query = await q.json()
    if (voice.speed != null) query.speedScale = voice.speed
    if (voice.pitch != null) query.pitchScale = voice.pitch
    if (voice.intonation != null) query.intonationScale = voice.intonation
    if (voice.volume != null) query.volumeScale = voice.volume
    query.prePhonemeLength = 0.05
    query.postPhonemeLength = 0.1
    const s = await fetch(`${base}/synthesis?speaker=${speaker}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) })
    if (!s.ok) throw new Error('synthesis HTTP ' + s.status)
    return Buffer.from(await s.arrayBuffer())
  }

  // ゆっくり音声: ライセンスを満たした AquesTalk 系ツールを外部コマンドとして呼ぶ。
  // 例 (settings.local.json): "command": "C:\\tools\\AquesTalkPlayer\\AquesTalkPlayer.exe /T \"{text}\" /P {preset} /W \"{file}\""
  // 引数の書式はツールによって違うので、使うツールの説明書に合わせて書き換えること。
  async _aquestalk (text, voice) {
    if (!this.aques.command) {
      // 未設定なら代わりの声 (VOICEVOX) で話す
      return this._voicevox(text, { speaker_name: voice.fallback_speaker_name || this.aques.fallback_speaker_name, speed: 1.0 })
    }
    const file = path.resolve(this.outDir, `aq_${Date.now()}_${this.seq++ % 1000}.wav`)
    const args = fillCommand(this.aques.command, { text, preset: voice.preset || 'れいむ', speed: voice.speed ?? 100, file })
    await new Promise((resolve, reject) => {
      const p = spawn(args[0], args.slice(1), { stdio: 'ignore', windowsHide: true })
      const t = setTimeout(() => { p.kill(); reject(new Error('aquestalk timeout')) }, 15000)
      p.on('error', e => { clearTimeout(t); reject(e) })
      p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('aquestalk exit ' + code)) })
    })
    const buf = fs.readFileSync(file)
    fs.rm(file, () => {})
    return buf
  }

  // priority: 0=プレイヤーとの会話 1=通常の発言。返り値は再生が終わると解決する Promise
  speak (character, text, { priority = 1 } = {}) {
    if (!this.enabled) return Promise.resolve(false)
    const t = cleanForSpeech(text, this.maxChars)
    if (!t) return Promise.resolve(false)
    const voice = character.voice || {}
    const engine = this.synth[voice.engine || 'voicevox'] || this.synth.voicevox
    let done
    const finished = new Promise(resolve => { done = resolve })
    const job = { name: character.username, text: t, priority, seq: this.seq++, done }
    job.wav = engine(t, voice).catch(e => { log.warn('voice', `合成失敗(${character.username}): ${e.message}`); return null })
    this.queue.push(job)
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
    // 混雑時は優先度の低い古い発言から捨てる
    while (this.queue.length > this.maxQueue) {
      const lowest = Math.max(...this.queue.map(j => j.priority))
      const [drop] = this.queue.splice(this.queue.findIndex(j => j.priority === lowest), 1)
      drop.done(false)
    }
    this._pump()
    return finished
  }

  isSpeaking (marginMs = 600) { return this.playing || Date.now() < this.speakingUntil + marginMs }

  pending () { return this.queue.length + (this.playing ? 1 : 0) }

  async _pump () {
    if (this.playing) return
    this.playing = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()
        const wav = await job.wav
        if (!wav) { job.done(false); continue }
        const file = path.resolve(this.outDir, `${Date.now()}_${job.seq % 1000}_${job.name}.wav`)
        fs.writeFileSync(file, wav)
        try { await this._play(file) } catch (e) { log.warn('voice', '再生失敗: ' + e.message) }
        if (!this.keepFiles) fs.rm(file, () => {})
        this.speakingUntil = Date.now()
        job.done(true)
        await sleep(this.gapMs)
      }
    } finally { this.playing = false; this.speakingUntil = Date.now() }
  }

  _play (file) {
    let args
    if (this.player) args = fillCommand(this.player, { file })
    else if (process.platform === 'win32') args = ['powershell', '-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`]
    else if (process.platform === 'darwin') args = ['afplay', file]
    else args = ['aplay', '-q', file]
    return new Promise((resolve, reject) => {
      const p = spawn(args[0], args.slice(1), { stdio: 'ignore', windowsHide: true })
      p.on('error', reject)
      p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${args[0]} exit ${code}`)))
    })
  }
}

function norm (s) { return String(s).normalize('NFKC').replace(/[\s_＿]/g, '').toLowerCase() }
