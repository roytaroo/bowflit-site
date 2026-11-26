// プレイログで見つかった問題の修正の確認
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanSpeech } from '../src/agent/agent.js'
import { blockMatcher } from '../src/agent/actions.js'
import { WorldDisplay } from '../src/society/display.js'
import { Floor } from '../src/society/floor.js'

test('発言の後ろに付いた英語のゴミを取る', () => {
  assert.equal(cleanSpeech('今ならずんだ餅探しだstarttime'), '今ならずんだ餅探しだ')
  assert.equal(cleanSpeech('一緒に探しましょう！ startTime'), '一緒に探しましょう！')
  assert.equal(cleanSpeech('oak_logを集めよう'), 'oak_logを集めよう')
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
