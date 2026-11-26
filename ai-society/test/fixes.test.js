// プレイログで見つかった問題の修正の確認
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanSpeech, panFor } from '../src/agent/agent.js'
import { similarity } from '../src/society/society.js'
import { panWav } from '../src/voice/tts.js'
import { blockMatcher } from '../src/agent/actions.js'
import { WorldDisplay } from '../src/society/display.js'
import { Floor } from '../src/society/floor.js'

test('発言の後ろに付いた英語のゴミを取る', () => {
  assert.equal(cleanSpeech('今ならずんだ餅探しだstarttime'), '今ならずんだ餅探しだ')
  assert.equal(cleanSpeech('一緒に探しましょう！ startTime'), '一緒に探しましょう！')
  assert.equal(cleanSpeech('oak_logを集めよう'), '原木を集めよう')
  assert.equal(cleanSpeech('今日も一緒にstone_pickaxeを増やしましょう'), '今日も一緒に石のツルハシを増やしましょう')
  assert.equal(cleanSpeech('OKだよ！'), 'OKだよ！')
})

test('oak_log を頼まれても、他の種類の原木でよい', () => {
  const m = blockMatcher('oak_log')
  assert.ok(m('birch_log') && m('spruce_log') && m('oak_log'))
  assert.ok(!m('oak_planks'))
})

test('頭上表示に alignment を付ける (サーバーのエラー表示を防ぐ)', () => {
  const d = new WorldDisplay({ enabled: true, version: '1.21.4' })
  const out = []; d.send = c => out.push(c)
  d.attach({ username: 'Zundamon', display_name: 'ずんだもん', color: '#7CC242' })
  const summons = out.filter(c => c.includes('summon text_display'))
  assert.equal(summons.length, 2)
  for (const c of summons) assert.match(c, /alignment:"center"/)
})

test('「みんな」への返事は進行役LLMなしで即決し、態度がばらける', async () => {
  const mk = (name, sociability) => ({ name, character: { sociability } })
  const society = { config: { floor: {} }, characters: new Map() }
  const f = new Floor(society)
  const plan = await f.choose({ from: 'Daiki', text: 'みんなヤッホー', listeners: [mk('A', 0.9), mk('B', 0.6), mk('C', 0.3)], addressed: [], isGroup: true })
  assert.equal(plan.length, 2)
  assert.equal(new Set(plan.map(p => p.stance)).size, plan.length)
  assert.equal(f.busy(), false)
})

test('他の住人のセリフの真似を見分ける', () => {
  assert.ok(similarity('今日も一緒に石のツルハシを増やしましょう。また家を建てよね。', 'ずんだもん、今日も石のツルハシを増やしましょう。また家を建てよね。') >= 0.6)
  assert.ok(similarity('ヤッホー！ずんだ餅探そうぜ！', 'わたくしもヤッホー！宝石探しと建築の話題でもどうでしょうか？') < 0.6)
})

test('声の左右: 北を向いたプレイヤーの東(右)にいる住人は右から聞こえる', () => {
  const player = { position: { x: 0, y: 64, z: 0 }, yaw: 0 }
  assert.ok(panFor(player, { x: 10, y: 64, z: 0 }) > 0.9)
  assert.ok(panFor(player, { x: -10, y: 64, z: 0 }) < -0.9)
  assert.ok(Math.abs(panFor(player, { x: 0, y: 64, z: -10 })) < 0.01)
})

test('モノラルのWAVを左右の音量が違うステレオにする', () => {
  const n = 10; const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(1000, 44 + i * 2)
  const o = panWav(b, 1)
  assert.equal(o.readUInt16LE(22), 2)
  assert.ok(o.readInt16LE(46) > o.readInt16LE(44))
})
