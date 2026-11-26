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
        if (config.voice_input?.echo_to_chat !== false) echoToChat(society, player, text)
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

// プレイヤーが声・別ウィンドウで話した内容をゲーム内チャットにも表示する。
// 起動役 (launch.js) がこの印の行を見つけて、サーバーの操作画面から tellraw を実行する (住人にOP権限は渡さない)
function echoToChat (society, player, text) {
  const msg = JSON.stringify({ text: `<${society.displayName(player)}> ${String(text).replace(/[\r\n]+/g, ' ')}`, color: 'white' })
  console.log('@@CMD tellraw @a ' + msg)
}
