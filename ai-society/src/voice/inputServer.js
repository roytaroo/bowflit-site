// マイク入力プログラム (voice_input/talk.py) から認識結果を受け取るローカルHTTPサーバー。
// 127.0.0.1 だけで待ち受けるので、同じPCからしか使えない。
//   POST /utterance  {"text":"みんな、ダイヤ探しに行こう","player":"daiki"}
//   GET  /status     → {"speaking":bool, ...}   常時会話モードで自分のスピーカー音を拾わないため
//   GET  /names      → 住人の名前一覧 (音声認識のヒントに使う)
import http from 'node:http'
import { log } from '../util/log.js'

export function startInputServer ({ society, tts, config }) {
  const port = config.voice_input?.port ?? 8765
  const playerName = config.player?.name || 'Player'
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
    try {
      if (req.method === 'GET' && req.url === '/status') {
        return send(200, { speaking: tts?.isSpeaking?.() || false, voice_pending: tts?.pending?.() || 0, llm_pending: society.llm.pending(), human_thread: society.conversation.humanThreadActive() })
      }
      if (req.method === 'GET' && req.url === '/names') {
        const names = []
        for (const a of society.aliveAgents()) names.push(a.display, ...(a.character.nicknames || []))
        return send(200, { names, player: playerName })
      }
      if (req.method === 'POST' && req.url === '/utterance') {
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 10000) throw new Error('too large') }
        const data = JSON.parse(body || '{}')
        const text = String(data.text || '').trim()
        if (!text) return send(400, { ok: false, error: 'text is empty' })
        const player = data.player || playerName
        if (config.voice_input?.echo_to_chat) echoToChat(society, player, text)
        // 返事は非同期で進む (進行役 → 各住人)。ここではすぐ受付を返す
        society.floor.handleHuman(player, text, { source: 'voice' }).catch(e => log.warn('voice-in', e.message))
        return send(200, { ok: true })
      }
      send(404, { ok: false })
    } catch (e) {
      send(500, { ok: false, error: e.message })
    }
  })
  server.listen(port, '127.0.0.1', () => log.info('voice-in', `マイク入力を待ち受け中 http://127.0.0.1:${port}`))
  return server
}

// プレイヤーの声の内容をゲーム内チャットにも表示する (住人ボットの1人にOP権限が必要)
function echoToChat (society, player, text) {
  const bot = society.aliveAgents().find(a => a.ready())?.bot
  if (!bot) return
  const msg = JSON.stringify({ text: `[${society.displayName(player)}🎤] ${text}`, color: 'gray' })
  try { bot.chat(`/tellraw @a ${msg}`) } catch {}
}
