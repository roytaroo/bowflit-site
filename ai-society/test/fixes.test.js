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

test('口調チェック: 設定書の一人称・語尾・禁止表現', async () => {
  const fs = await import('node:fs')
  const { voiceIssues, fixVoice } = await import('../src/agent/voiceStyle.js')
  const ch = n => JSON.parse(fs.readFileSync(new URL(`../characters/${n}.json`, import.meta.url), 'utf8'))
  const z = ch('zundamon'); const m = ch('metan'); const k = ch('kiritan')
  assert.deepEqual(voiceIssues(z, 'ボクが一番なのだ！'), [])
  assert.ok(voiceIssues(z, '私も行きます。よろしくお願いします').length)
  assert.equal(fixVoice(z, '私も行きます'), 'ボクも行くのだ')
  assert.equal(fixVoice(z, '一緒に作りましょう！今日は元気です'), '一緒に作るのだ！今日は元気なのだ')
  assert.deepEqual(voiceIssues(m, 'べ、別にあんたのためじゃないわよ'), [])
  assert.ok(voiceIssues(m, 'わたくしもヤッホーですわ').length)
  assert.deepEqual(voiceIssues(k, 'はいはい、うるさい'), [])
  assert.ok(voiceIssues(k, 'まあ、いいですけど').length)
  // 公式設定書の例文は全部チェックを通る
  for (const c of [z, m, k]) for (const e of c.examples) assert.deepEqual(voiceIssues(c, e), [], `${c.display_name}: ${e}`)
})

test('考えごとの言葉が混ざった文は話さない', async () => {
  const { dropMetaTalk } = await import('../src/agent/agent.js')
  assert.equal(dropMetaTalk('原木を増やす短期目標を設定するのだ。きりたん、一緒に行くのだ！'), 'きりたん、一緒に行くのだ！')
  assert.equal(dropMetaTalk('ずんだ餅を食べるのだ！'), 'ずんだ餅を食べるのだ！')
})

test('Minecraft の最大FPSを上限付きにする', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path')
  const { capMaxFps } = await import('../scripts/client-setup.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'))
  fs.writeFileSync(path.join(dir, 'options.txt'), 'version:3953\nmaxFps:260\nfov:0.0\n')
  assert.deepEqual(capMaxFps(60, dir), { changed: true, from: 260 })
  assert.match(fs.readFileSync(path.join(dir, 'options.txt'), 'utf8'), /^maxFps:60$/m)
  assert.deepEqual(capMaxFps(60, dir), { changed: false, from: 60 })
})

test('スキンがスリム(腕3ピクセル)かクラシックかを画像から見分ける', async () => {
  const { skinVariant } = await import('../scripts/skin.js')
  const f = n => new URL(`../skins/${n}.png`, import.meta.url).pathname
  assert.equal(skinVariant(f('metan')), 'classic')
  assert.equal(skinVariant(f('zundamon')), 'slim')
  assert.equal(skinVariant(f('kiritan')), 'slim')
})

test('目が合ったか (プレイヤーの視線がこちらを向いている)', async () => {
  const { lookingAt } = await import('../src/agent/agent.js')
  const { Vec3 } = await import('vec3')
  const player = { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 } // 北(-z)を向いている
  assert.ok(lookingAt(player, new Vec3(0, 64, -6)))
  assert.ok(!lookingAt(player, new Vec3(6, 64, 0)))
  assert.ok(!lookingAt(player, new Vec3(0, 64, 6)))
})

test('自分の仕事: 素材が無ければ木→石、家の場所→家づくり、の順に選ぶ', async () => {
  const { Agent } = await import('../src/agent/agent.js')
  const { Store } = await import('../src/memory/db.js')
  const { Society } = await import('../src/society/society.js')
  const { LLMClient } = await import('../src/llm/client.js')
  const { MockProvider } = await import('../src/llm/mock.js')
  const store = new Store(':memory:')
  const soc = new Society({ store, llm: new LLMClient({ provider: 'mock' }, { mockProvider: new MockProvider() }), config: { conversation: {}, agent: {} } })
  const a = new Agent({ username: 'Z', display_name: 'ず', relationships: {}, chores: [{ name: 'plant_and_harvest', args: {} }] }, soc)
  a.bot = { isSleeping: false }
  const st = inv => () => ({ night: false, inWater: false, health: 20, hostiles: [], players: [], inventory: inv })
  a.state = st([])
  assert.deepEqual(a._pickChore().args, { block: 'log', count: 6 })
  a.state = st([{ name: 'oak_log', count: 10 }])
  assert.equal(a._pickChore().args.block, 'stone')
  a.state = st([{ name: 'oak_log', count: 10 }, { name: 'cobblestone', count: 30 }])
  assert.equal(a._pickChore().name, 'set_home')
  a.home = { x: 0, y: 64, z: 0 }
  assert.equal(a._pickChore().name, 'build_house')
  a.state = () => ({ night: true, inWater: false, health: 20, hostiles: [], players: [], inventory: [] })
  assert.equal(a._pickChore(), null) // 夜は仕事しない
})

test('意味のない行動を止める: 家の決め直し・無いお墓参り・約束の計画', async () => {
  const { Safety } = await import('../src/agent/safety.js')
  const sf = new Safety({})
  const base = { health: 20, food: 20, foodItems: [], hostiles: [], players: [], inventory: [], gear: { weapon: 0, armor: 0 }, graves: [] }
  assert.equal(sf.vet({ name: 'set_home', args: {} }, { ...base, home: { x: 0, y: 0, z: 0 } }).ok, false)
  assert.equal(sf.vet({ name: 'set_home', args: {} }, base).ok, true)
  assert.equal(sf.vet({ name: 'visit_grave', args: { for: '故人の名前' } }, base).ok, false)
  assert.equal(sf.vet({ name: 'propose_project', args: { title: '原木集めの約束', detail: '' } }, base).ok, false)
  assert.equal(sf.vet({ name: 'propose_project', args: { title: 'みんなの橋' } }, { ...base, recentProposal: true }).ok, false)
  const g = sf.vet({ name: 'give', args: { to: 'Zundamon', item: 'stone_pickaxex1' } }, base)
  assert.equal(g.action.args.item, 'stone_pickaxe')
  assert.equal(g.action.args.count, 1)
})
