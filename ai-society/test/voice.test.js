// 音声会話まわりのテスト: 進行役 (誰が返事するか)・TTSキュー・コマンド分解・入力サーバー
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Store } from '../src/memory/db.js'
import { LLMClient } from '../src/llm/client.js'
import { MockProvider } from '../src/llm/mock.js'
import { Society } from '../src/society/society.js'
import { Agent } from '../src/agent/agent.js'
import { GROUP_WORDS } from '../src/society/floor.js'
import { TTS, splitCommand, fillCommand, cleanForSpeech } from '../src/voice/tts.js'
import { startInputServer } from '../src/voice/inputServer.js'

const CH = [
  ['Zundamon', 'ずんだもん', ['ずんだ'], 0.9],
  ['Metan', '四国めたん', ['めたん'], 0.7],
  ['Kiritan', '東北きりたん', ['きりたん'], 0.4],
  ['Reimu', '霊夢', ['れいむ'], 0.5]
].map(([username, display_name, nicknames, sociability]) => ({ username, display_name, nicknames, sociability, personality: `${display_name}の性格。`, speech: 's', relationships: {} }))

function world ({ provider = null, floor = {} } = {}) {
  const store = new Store(':memory:')
  const mock = provider || new MockProvider({ latencyMs: 1 })
  const llm = new LLMClient({ provider: 'mock' }, { mockProvider: mock })
  const config = { agent: {}, conversation: { reply_delay_ms: 0 }, memory: {}, safety: {}, death: {}, minecraft: {}, player: { name: 'Daiki', display_name: 'だいき' }, floor }
  const soc = new Society({ store, llm, config })
  const agents = CH.map(c => new Agent(c, soc))
  soc.seedRelationships(CH)
  const said = []
  agents.forEach((a, i) => {
    a.bot = { entity: { position: new Vec3(i * 3, 64, 0) }, time: { day: 1 }, chat: t => said.push([a.name, t]), players: { Daiki: { entity: { position: new Vec3(0, 64, 0) } } }, game: {}, inventory: { items: () => [] }, pathfinder: { stop () {} }, pvp: { stop () {} }, entities: {} }
    a.bot.pathfinder = { stop () {} }
  })
  return { soc, agents, said }
}

test('名前を呼ぶと、その人が最初に返事する', async () => {
  const { soc } = world({ floor: { interject_chance: 0 } })
  const r = await soc.floor.handleHuman('Daiki', 'きりたん、今なにしてるの?')
  assert.equal(r.plan[0].name, 'Kiritan')
  assert.equal(r.plan.length, 1)
  assert.equal(r.thread.lines[1].who, 'Kiritan')
})

test('「みんな」で全員が聞き、進行役が複数人を態度つきで選ぶ', async () => {
  const { soc, agents } = world()
  const r = await soc.floor.handleHuman('Daiki', 'みんな、今日はダイヤを探しに行かない?')
  assert.ok(r.plan.length >= 2, '複数人が反応')
  assert.ok(new Set(r.plan.map(p => p.stance)).size >= 2, '態度がばらける')
  for (const a of agents) assert.ok(a.memory.recent(5).some(m => m.content.includes('ダイヤ') && m.about === 'Daiki'), `${a.name}が発言を記憶`)
  const says = r.thread.lines.slice(1).map(l => l.text)
  assert.ok(says.length >= 2)
})

test('同じ発言が複数のボットから届いても1回だけ処理', async () => {
  const { soc } = world()
  const [a, b] = await Promise.all([soc.floor.handleHuman('Daiki', 'ずんだもん、おはよう'), soc.floor.handleHuman('Daiki', 'ずんだもん、おはよう')])
  assert.ok((a && !b) || (!a && b))
})

test('話を振る (ask) と、振られた人が続けて答える', async () => {
  let n = 0
  const provider = {
    chat: async (m) => {
      const sys = m[0].content
      if (sys.includes('進行役')) return { text: '{"responders":[{"name":"Metan","stance":"他人に振る"}]}' }
      n++
      return { text: n === 1 ? '{"say":"きりたんはどう思いますの?","ask":"きりたん"}' : '{"say":"効率悪いのでパスです"}' }
    }
  }
  const { soc } = world({ provider })
  const r = await soc.floor.handleHuman('Daiki', 'みんな、釣りしない?')
  assert.deepEqual(r.thread.lines.slice(1).map(l => l.who), ['Metan', 'Kiritan'])
})

test('返事しなくてよい: 進行役が誰も選ばなければ誰も話さない', async () => {
  const provider = { chat: async () => ({ text: '{"responders":[]}' }) }
  const { soc, said } = world({ provider })
  const r = await soc.floor.handleHuman('Daiki', 'ふぅ、疲れた')
  assert.equal(r.plan.length, 0)
  assert.equal(said.length, 0)
})

test('プレイヤーとの会話中は、AI同士の自動返事が止まる', () => {
  const { soc } = world()
  soc.conversation.holdForHuman(5000)
  assert.equal(soc.conversation.shouldReply('Metan', { id: 1, from: 'Zundamon', fromIsBot: true, text: 'めたん!', addressed: ['Metan'] }), false)
})

test('頼みごとを引き受けると行動が予約される', async () => {
  const provider = { chat: async () => ({ text: '{"say":"了解なのだ","action":{"name":"collect","args":{"block":"log","count":5}}}' }) }
  const { soc, agents } = world({ provider })
  await soc.floor.handleHuman('Daiki', 'ずんだもん、木を5個集めてきて')
  assert.equal(agents[0].pendingAction.name, 'collect')
})

test('「みんな」等の判定', () => {
  assert.ok(GROUP_WORDS.test('みんな聞いて'))
  assert.ok(GROUP_WORDS.test('全員集合'))
  assert.ok(!GROUP_WORDS.test('ずんだもん、来て'))
})

test('コマンドの分解と差し込み (シェルを通さない)', () => {
  assert.deepEqual(splitCommand('"C:\\a b\\x.exe" /T "{text}" /P {preset}'), ['C:\\a b\\x.exe', '/T', '{text}', '/P', '{preset}'])
  assert.deepEqual(fillCommand('x /T "{text}" /W "{file}"', { text: 'こんにちは "&| rm', file: 'o.wav' }), ['x', '/T', 'こんにちは "&| rm', '/W', 'o.wav'])
  assert.equal(cleanForSpeech('やった!🎉 https://x.y **太字**'), 'やった! 太字')
})

test('TTS: 優先度順に再生され、混雑時は通常発言から捨てる', async () => {
  const tts = new TTS({ enabled: true, out_dir: '/tmp/claude-0/tts-test', gap_ms: 0, max_queue: 3 })
  const order = []
  tts.synth.voicevox = async (t) => Buffer.from(t)
  tts._play = async (file) => { order.push(file.split('_').pop()) }
  const c = n => ({ username: n, voice: {} })
  const ps = [tts.speak(c('A'), 'a1'), tts.speak(c('B'), 'b1'), tts.speak(c('C'), 'c1'), tts.speak(c('D'), 'd1'), tts.speak(c('P'), 'p0', { priority: 0 })]
  const res = await Promise.all(ps)
  assert.equal(order[0], 'A.wav', '再生中のものはそのまま')
  assert.equal(order[1], 'P.wav', 'プレイヤーへの返事が先')
  assert.equal(res.filter(x => x === false).length, 1, '1件捨てられる')
})

test('TTS: VOICEVOXの話者を名前とスタイルで解決 (全角・アンダーバー揺れも吸収)', () => {
  const tts = new TTS({})
  tts.speakerIds.set('ずんだもん/ノーマル', 3)
  tts.speakerIds.set('ナースロボタイプt/ノーマル', 47)
  tts.speakerIds.set('白上虎太郎/ふつう', 12)
  assert.equal(tts.resolveSpeaker({ speaker_name: 'ずんだもん' }), 3)
  assert.equal(tts.resolveSpeaker({ speaker_name: 'ナースロボ＿タイプＴ' }), 47)
  assert.equal(tts.resolveSpeaker({ speaker_name: '白上虎太郎', style: 'わーい' }), 12)
  assert.equal(tts.resolveSpeaker({ speaker_name: '存在しない' }), null)
})

test('マイク入力サーバー: 発言を受け取って進行役へ渡す', async () => {
  const { soc } = world({ floor: { interject_chance: 0 } })
  const got = []
  soc.floor.handleHuman = async (p, t, o) => { got.push([p, t, o.source]); return null }
  const server = startInputServer({ society: soc, tts: { isSpeaking: () => true, pending: () => 0 }, config: { player: { name: 'Daiki' }, voice_input: { port: 18765 } } })
  await new Promise(resolve => server.once('listening', resolve))
  const r = await fetch('http://127.0.0.1:18765/utterance', { method: 'POST', body: JSON.stringify({ text: 'めたん、こんにちは' }) })
  assert.equal((await r.json()).ok, true)
  const st = await (await fetch('http://127.0.0.1:18765/status')).json()
  assert.equal(st.speaking, true)
  const names = await (await fetch('http://127.0.0.1:18765/names')).json()
  assert.ok(names.names.includes('四国めたん'))
  server.close()
  assert.deepEqual(got, [['Daiki', 'めたん、こんにちは', 'voice']])
})

test('続けて話しかけても、会話は1つずつ順番に処理される', async () => {
  const { soc, said } = world({ floor: { interject_chance: 0 } })
  const [a, b] = await Promise.all([soc.floor.handleHuman('Daiki', 'みんな、釣りしない?'), soc.floor.handleHuman('Daiki', 'めたん、どう?')])
  const nA = a.thread.lines.length - 1
  assert.ok(nA >= 1)
  assert.equal(b.plan[0].name, 'Metan')
  // 最初の会話の返事が全部終わってから、次の会話の返事が出る
  assert.equal(said.length, nA + b.thread.lines.length - 1)
  assert.equal(said[nA][0], 'Metan')
  assert.deepEqual(said.slice(0, nA).map(x => x[1]), a.thread.lines.slice(1).map(l => l.text))
})
