import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/memory/db.js'
import { Experience, causeJa } from '../src/agent/experience.js'

function fakeAgent () {
  const store = new Store(':memory:')
  return { name: 'Zundamon', store, day: () => 2, village: { center: { x: 0, y: 64, z: 0 } }, society: { displayName: n => ({ Zundamon: 'ずんだもん', Metan: '四国めたん' })[n] || n } }
}

test('経験: 死んだ方向は探検で避ける', () => {
  const e = new Experience(fakeAgent())
  e.add('died', { cause: 'ゾンビの攻撃', pos: { x: 40, y: 64, z: 0 } }) // 家から東
  const r = e.safeDirection({ x: 0, y: 64, z: 0 }, 'east', 48)
  assert.notEqual(r.dir, 'east')
  assert.equal(r.avoided, '東')
  assert.ok(e.exploreFactor() < 1)
})

test('経験: 何度も倒れるのを見たら「死にすぎ」と思う / 見つけた鉱石の場所を覚える', () => {
  const e = new Experience(fakeAgent())
  for (let i = 0; i < 3; i++) e.add('saw_death', { who: 'Metan', cause: '落下' })
  assert.equal(e.knownDeathsOf('Metan'), 3)
  assert.match(e.text(), /四国めたん.*3回目.*死にすぎ/)
  e.found('deepslate_iron_ore', { x: 10, y: 20, z: -30 })
  e.found('iron', { x: 12, y: 20, z: -31 }) // 同じ場所は重ねて覚えない
  assert.deepEqual(e.resourceSpot('iron_ore'), { x: 10, y: 20, z: -30 })
  assert.match(e.text(), /鉄鉱石を見つけた/)
})

test('経験: 死因を日本語に', () => {
  assert.equal(causeJa('was blown up by Creeper'), 'クリーパーの爆発')
  assert.equal(causeJa('was slain by Zombie'), 'ゾンビの攻撃')
  assert.equal(causeJa('drowned'), 'おぼれたこと')
})
