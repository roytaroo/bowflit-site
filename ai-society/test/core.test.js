// サーバー不要の単体テスト: 記憶・人間関係・安全管理・会話制御・LLMキュー・日記・死亡処理
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/memory/db.js'
import { AgentMemory, SharedMemory } from '../src/memory/memory.js'
import { Relationships } from '../src/society/relationships.js'
import { ConversationManager, splitChat, findAddressed } from '../src/society/conversation.js'
import { Safety } from '../src/agent/safety.js'
import { LLMClient, extractJson, PRIORITY } from '../src/llm/client.js'
import { MockProvider } from '../src/llm/mock.js'
import { Society } from '../src/society/society.js'
import { Agent } from '../src/agent/agent.js'
import { houseBlueprint, blockMatcher } from '../src/agent/actions.js'
import { Vec3 } from 'vec3'

const baseState = (o = {}) => ({
  pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, night: false, phase: '昼', inventory: [], gear: { weapon: -1, armor: 0, label: '素手' },
  foodItems: [], hostiles: [], players: [], blocks: {}, home: null, inLava: false, onFire: false, ...o
})

test('記憶は人ごとに分離される', () => {
  const s = new Store(':memory:')
  const a = new AgentMemory(s, 'Haru'); const b = new AgentMemory(s, 'Rin')
  a.add('event', 'ダイヤを見つけた', { importance: 8 })
  b.add('event', '倉庫を整理した', { importance: 4 })
  assert.equal(a.recent(10).length, 1)
  assert.equal(b.recent(10)[0].content, '倉庫を整理した')
  assert.ok(!a.recall('倉庫', 5).some(m => m.content.includes('倉庫')))
})

test('想起: 関連する記憶が上に来る', () => {
  const s = new Store(':memory:')
  const m = new AgentMemory(s, 'Haru')
  for (let i = 0; i < 20; i++) m.add('event', `木を切った${i}`, { importance: 2 })
  m.add('event', '洞窟でクリーパーに襲われた', { importance: 6 })
  m.add('lesson', 'クリーパーを見たら距離を取る', { importance: 8 })
  const r = m.recall('近くの敵: creeper クリーパー 洞窟', 3).map(x => x.content)
  assert.ok(r.some(c => c.includes('クリーパー')))
})

test('記憶の整理: 古い低重要度の記憶が要約される', async () => {
  const s = new Store(':memory:')
  const m = new AgentMemory(s, 'Haru', { maxActive: 20, consolidateBatch: 15 })
  for (let i = 0; i < 30; i++) m.add('event', `細かい出来事${i}`, { importance: 2, day: 1 })
  m.add('death', '溶岩で死んだ', { importance: 9 })
  const sum = await m.consolidate(async texts => `まとめ(${texts.length}件)`)
  assert.equal(sum, 'まとめ(15件)')
  assert.equal(m.countActive(), 31 - 15 + 1)
  assert.ok(m.recent(100).some(x => x.kind === 'death'), '重要な記憶は残る')
})

test('人間関係: 出来事の記録で変化し、根拠が残る', () => {
  const s = new Store(':memory:')
  const r = new Relationships(s)
  r.init('Haru', 'Jin', { label: 'ライバル', affinity: 0, trust: 0 })
  r.record('Haru', 'Jin', 'ジンに命を救われた', 'saved_life')
  r.record('Haru', 'Jin', 'ジンが約束を破った', 'promise_broken')
  const row = r.get('Haru', 'Jin')
  assert.equal(row.affinity, 15 - 6)
  assert.equal(row.trust, 20 - 15)
  assert.equal(r.get('Jin', 'Haru'), undefined, '関係は片方向')
  const d = r.describe('Haru')
  assert.match(d, /ライバル/)
  assert.match(d, /命を救われた/)
  r.setImpression('Haru', 'Jin', '口は悪いが頼れる', '戦友')
  assert.match(r.describe('Haru'), /戦友.*頼れる/)
})

test('会話制御: AI同士の往復は上限でクールダウン', () => {
  const c = new ConversationManager({ max_bot_exchanges: 3, pair_cooldown_sec: 60 })
  const t0 = 1_000_000
  let msg = { id: 1, from: 'Haru', fromIsBot: true, text: 'リン', addressed: ['Rin'] }
  assert.equal(c.shouldReply('Rin', msg, { now: t0 }), true)
  c.noteBotMessage('Rin', 'Haru', t0); c.noteBotMessage('Haru', 'Rin', t0 + 1); c.noteBotMessage('Rin', 'Haru', t0 + 2)
  msg = { id: 2, from: 'Haru', fromIsBot: true, text: 'リン?', addressed: ['Rin'] }
  assert.equal(c.shouldReply('Rin', msg, { now: t0 + 3 }), false)
  assert.equal(c.shouldReply('Rin', msg, { now: t0 + 61_000 }), true)
})

test('会話制御: 名指しされていない発言には1人だけ反応', () => {
  const c = new ConversationManager()
  const msg = { id: 9, from: 'daiki', fromIsBot: false, text: 'みんなおはよう', addressed: [] }
  const r = ['Haru', 'Rin', 'Popo'].map(n => c.shouldReply(n, msg, { rng: () => 0 }))
  assert.deepEqual(r, [true, false, false])
})

test('チャット分割と名指し検出', () => {
  assert.ok(splitChat('あ'.repeat(250)).every(s => s.length <= 101))
  assert.deepEqual(findAddressed('ハル、一緒に行こう', ['Haru', 'ハル', 'Rin', 'リン']), ['ハル'])
})

test('安全管理: 体力が低いと戦闘禁止・逃走反射', () => {
  const sf = new Safety()
  assert.equal(sf.vet({ name: 'attack', args: { target: 'zombie' } }, baseState({ health: 8 })).ok, false)
  assert.equal(sf.vet({ name: 'attack', args: { target: 'warden' } }, baseState()).ok, false)
  assert.equal(sf.vet({ name: 'attack', args: { target: 'zombie' } }, baseState()).ok, true)
  const r = sf.reflex(baseState({ health: 6, hostiles: [{ name: 'zombie', dist: 4 }] }))
  assert.equal(r.name, 'flee')
  assert.equal(sf.reflex(baseState({ food: 10, foodItems: [{ name: 'bread', count: 2 }] })).name, 'eat')
  assert.equal(sf.reflex(baseState({ inLava: true })).name, 'escape_hazard')
})

test('安全管理: 装備に応じて探索距離を制限、夜の素手探索は禁止', () => {
  const sf = new Safety()
  const v = sf.vet({ name: 'explore', args: { direction: 'north', distance: 1000 } }, baseState())
  assert.equal(v.ok, true)
  assert.equal(v.action.args.distance, 64)
  assert.equal(sf.vet({ name: 'explore', args: { distance: 30 } }, baseState({ night: true })).ok, false)
  sf.setCaution(4)
  assert.ok(sf.exploreLimit(baseState()) < 64, '死亡で慎重になる')
  assert.ok(sf.fleeHealth > 8)
})

test('JSON抽出: thinkタグやコードブロックを含んでも読める', () => {
  assert.deepEqual(extractJson('<think>hmm</think>\n```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('はい: {"say":"a}b","n":{"x":2}} 以上'), { say: 'a}b', n: { x: 2 } })
})

test('LLMキュー: 会話の返事が計画より優先される', async () => {
  const order = []
  const provider = { chat: async (m) => { order.push(m[0].content); await new Promise(resolve => setTimeout(resolve, 10)); return { text: '{}' } } }
  const llm = new LLMClient({ provider: 'mock', concurrency: 1 }, { mockProvider: provider })
  const ps = [
    llm.request([{ content: 'decide1' }], { priority: PRIORITY.DECIDE }),
    llm.request([{ content: 'diary' }], { priority: PRIORITY.REFLECT }),
    llm.request([{ content: 'decide2' }], { priority: PRIORITY.DECIDE }),
    llm.request([{ content: 'chat' }], { priority: PRIORITY.CHAT })
  ]
  await Promise.all(ps)
  assert.deepEqual(order, ['decide1', 'chat', 'decide2', 'diary'])
})

test('建築の設計図とブロック名の解釈', () => {
  const bp = houseBlueprint(new Vec3(0, 0, 0), 5)
  assert.equal(bp.length, 16 * 3 - 2 + 25)
  assert.ok(blockMatcher('木')('birch_log'))
  assert.ok(blockMatcher('iron_ore')('deepslate_iron_ore'))
})

// --- Agent をサーバーなしで動かす (偽のbot) ---
function fakeSociety (extra = {}) {
  const store = new Store(':memory:')
  const llm = new LLMClient({ provider: 'mock' }, { mockProvider: new MockProvider({ latencyMs: 1 }) })
  const config = { agent: {}, conversation: {}, memory: {}, safety: {}, death: { permanent: false }, minecraft: {}, ...extra }
  return new Society({ store, llm, config })
}
const chars = ['Haru', 'Rin', 'Popo'].map((n, i) => ({ username: n, display_name: ['ハル', 'リン', 'ポポ'][i], personality: 'p', speech: 's', relationships: {} }))
function fakeBot () {
  return { entity: { position: new Vec3(0, 64, 0) }, time: { day: 3 }, chat: () => {}, players: {}, game: { dimension: 'overworld' }, inventory: { items: () => [] }, pathfinder: { stop () {} }, pvp: { stop () {} } }
}

test('日記: 書かれて保存され、印象・教訓が反映される', async () => {
  const soc = fakeSociety()
  const agents = chars.map(c => new Agent(c, soc))
  soc.seedRelationships(chars)
  const haru = agents[0]; haru.bot = fakeBot()
  haru.memory.add('event', 'リンと木を集めた', { day: 3, about: 'Rin' })
  soc.llm.provider.chat = async () => ({ text: JSON.stringify({ diary: '今日はリンと木を集めた。', tomorrow: '家を建てる', impressions: [{ name: 'リン', impression: '手際がいい', label: '相棒' }], growth: '一人より二人', lesson: '夜は早めに帰る' }) })
  const text = await haru.writeDiary(3)
  assert.match(text, /リン/)
  assert.equal(soc.store.get('SELECT COUNT(*) n FROM diaries').n, 1)
  assert.equal(soc.relations.get('Haru', 'Rin').label, '相棒')
  assert.match(soc.store.getAgent('Haru').growth, /二人/)
  assert.equal(haru.memory.lessons().length, 1)
  assert.equal(await haru.writeDiary(3), null, '同じ日は二度書かない')
})

test('死亡: 記録・教訓・慎重さ上昇・仲間への通知・墓の提案', async () => {
  const soc = fakeSociety({ death: { permanent: true } })
  const agents = chars.map(c => new Agent(c, soc))
  soc.seedRelationships(chars)
  for (const a of agents) a.bot = fakeBot()
  const popo = agents[2]
  popo.stop = () => {}
  popo.lastDeathMsg = { msg: 'Popo tried to swim in lava', t: Date.now() }
  await popo._onDeath()
  await new Promise(resolve => setTimeout(resolve, 100))
  const d = soc.store.get('SELECT * FROM deaths')
  assert.match(d.cause, /lava/)
  assert.equal(d.permanent, 1)
  assert.equal(soc.store.getAgent('Popo').alive, 0)
  assert.equal(soc.store.getAgent('Popo').caution, 1)
  assert.match(popo.memory.lessons()[0].content, /溶岩/)
  assert.ok(agents[0].memory.recent(10).some(m => m.kind === 'death' && m.about === 'Popo'), '仲間が死を記憶')
  const proj = soc.store.get("SELECT * FROM projects WHERE kind = 'grave'")
  assert.ok(proj, '墓の計画が提案される')
  assert.match(soc.describeProjects(), /ポポのお墓/)
  assert.ok(soc.shared.recent(5).some(e => e.kind === 'death'))
})

test('プレゼント: もらった側の記憶と関係が変わる', () => {
  const soc = fakeSociety()
  const agents = chars.map(c => new Agent(c, soc))
  soc.seedRelationships(chars)
  agents[0].bot = fakeBot()
  agents[0].onGave('Rin', 'poppy', 1)
  assert.ok(soc.relations.get('Rin', 'Haru').affinity > 0)
  assert.ok(agents[1].memory.recent(5).some(m => m.content.includes('poppy')))
})

test('安全管理: 溺れそうなら水から上がる、慎重さの効果には上限', () => {
  const sf = new Safety({ max_caution_effect: 3 })
  assert.equal(sf.reflex(baseState({ inWater: true, oxygen: 5 })).name, 'escape_hazard')
  sf.setCaution(10)
  assert.equal(sf.fleeHealth, 11)
  const r = sf.reflex(baseState({ health: 20, gear: { weapon: 1, armor: 0 }, hostiles: [{ name: 'zombie', dist: 3 }] }))
  assert.equal(r.name, 'attack', '武器と体力があれば1体なら応戦')
})
