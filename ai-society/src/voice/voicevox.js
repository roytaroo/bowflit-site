// VOICEVOX 連携。VOICEVOX ENGINE (アプリ起動中は http://127.0.0.1:50021) にHTTPで音声合成を依頼し、PCで再生する。
// - キャラクターごとに speaker(スタイルID)・速度・高さ・抑揚・音量を設定
// - 再生は1本のキューで順番に行うので、会話が重ならない
// - 合成は先読みして、再生の待ち時間を短くする
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { log, sleep } from '../util/log.js'

export class VoiceVox {
  constructor (cfg = {}) {
    this.enabled = !!cfg.enabled
    this.url = (cfg.url || 'http://127.0.0.1:50021').replace(/\/$/, '')
    this.outDir = cfg.out_dir || 'data/voice'
    this.gapMs = cfg.gap_ms ?? 400
    this.maxQueue = cfg.max_queue ?? 6
    this.maxChars = cfg.max_chars ?? 80
    this.player = cfg.player || null // 再生コマンドの上書き (例: "ffplay -nodisp -autoexit {file}")
    this.keepFiles = !!cfg.keep_files
    this.queue = []
    this.playing = false
    this.seq = 0
    if (this.enabled) fs.mkdirSync(this.outDir, { recursive: true })
  }

  async check () {
    try {
      const r = await fetch(this.url + '/version')
      return r.ok ? (await r.text()).replace(/"/g, '') : null
    } catch { return null }
  }

  async speakers () {
    const r = await fetch(this.url + '/speakers')
    if (!r.ok) throw new Error('VOICEVOX /speakers HTTP ' + r.status)
    return r.json()
  }

  async synthesize (text, voice = {}) {
    const speaker = voice.speaker ?? 3
    const q = await fetch(`${this.url}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: 'POST' })
    if (!q.ok) throw new Error('audio_query HTTP ' + q.status)
    const query = await q.json()
    if (voice.speed != null) query.speedScale = voice.speed
    if (voice.pitch != null) query.pitchScale = voice.pitch
    if (voice.intonation != null) query.intonationScale = voice.intonation
    if (voice.volume != null) query.volumeScale = voice.volume
    query.prePhonemeLength = 0.05
    query.postPhonemeLength = 0.1
    const s = await fetch(`${this.url}/synthesis?speaker=${speaker}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) })
    if (!s.ok) throw new Error('synthesis HTTP ' + s.status)
    return Buffer.from(await s.arrayBuffer())
  }

  // 発言をキューに積む。混み合ったら古いものから捨てる (会話がどんどん遅れていかないように)
  speak (character, text) {
    if (!this.enabled || !text) return
    const t = String(text).slice(0, this.maxChars)
    const job = { name: character.username, voice: character.voice || {}, text: t, wav: null }
    job.wav = this.synthesize(t, job.voice).catch(e => { log.warn('voice', `合成失敗(${character.username}): ${e.message}`); return null })
    this.queue.push(job)
    while (this.queue.length > this.maxQueue) this.queue.shift()
    this._pump()
  }

  async _pump () {
    if (this.playing) return
    this.playing = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()
        const wav = await job.wav
        if (!wav) continue
        const file = path.join(this.outDir, `${Date.now()}_${this.seq++ % 1000}_${job.name}.wav`)
        fs.writeFileSync(file, wav)
        await this._play(file).catch(e => log.warn('voice', '再生失敗: ' + e.message))
        if (!this.keepFiles) fs.rm(file, () => {})
        await sleep(this.gapMs)
      }
    } finally { this.playing = false }
  }

  _play (file) {
    let cmd; let args
    if (this.player) {
      const parts = this.player.split(' ').map(p => p.replace('{file}', file))
      cmd = parts[0]; args = parts.slice(1)
    } else if (process.platform === 'win32') {
      cmd = 'powershell'; args = ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`]
    } else if (process.platform === 'darwin') {
      cmd = 'afplay'; args = [file]
    } else {
      cmd = 'aplay'; args = ['-q', file]
    }
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: 'ignore' })
      p.on('error', reject)
      p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`)))
    })
  }
}
