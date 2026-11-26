// 頭上の名前・吹き出し・チャット表示のコマンド生成テスト
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorldDisplay, textNbt, argb, cleanText, datapackFiles } from '../src/society/display.js'

const zunda = { username: 'Zundamon', display_name: 'ずんだもん', color: '#7CC242' }

test('1.21.4 では text は JSON 文字列、引用符を安全にエスケープ', () => {
  assert.equal(textNbt({ text: "it's" }, '1.21.4'), `'{"text":"it\\'s"}'`)
  assert.equal(textNbt({ text: 'a' }, '26.1'), '{"text":"a"}')
})

test('色は ARGB の符号付き整数', () => {
  assert.equal(argb('#000000', 0x40), 0x40000000)
  assert.ok(argb('#7CC242', 0xD0) < 0)
})

test('LLMの文章から改行・制御文字・§を除く (コマンドを壊さない)', () => {
  assert.equal(cleanText('a\nb§c\u0001'), 'a bc')
})

test('名前と吹き出しを頭上に乗せ、発言はチャットと吹き出しに出す', () => {
  const sent = []
  const d = new WorldDisplay({ enabled: true, version: '1.21.4' })
  d.send = c => sent.push(c)
  d.attach(zunda)
  assert.ok(sent.some(c => c.startsWith('execute at Zundamon run summon text_display') && c.includes('ずんだもん') && c.includes('#7CC242')))
  assert.ok(sent.some(c => c.includes('teleport_duration:2')))
  sent.length = 0
  d.bubble(zunda, 'こんにちは\n/op evil')
  d.chat(zunda, 'こんにちは')
  assert.ok(sent[0].startsWith('data merge entity @e[type=text_display,tag=ais_Zundamon,tag=ais_bubble'))
  assert.ok(!sent[0].includes('\n'))
  const tell = JSON.parse(sent[1].replace('tellraw @a ', ''))
  assert.equal(tell[1].text, 'ずんだもん')
  assert.equal(tell[1].color, '#7CC242')
  clearTimeout(d.timers.get('Zundamon'))
})

test('データパック: 毎tick 住人の頭上へ表示を移動', () => {
  const f = datapackFiles(['Zundamon', 'Metan'])
  assert.match(f['data/ais/function/tick.mcfunction'], /execute as Zundamon at @s run tp @e\[type=text_display,tag=ais_Zundamon\] ~ ~1.9 ~/)
  assert.deepEqual(JSON.parse(f['data/minecraft/tags/function/tick.json']).values, ['ais:tick'])
  assert.equal(JSON.parse(f['pack.mcmeta']).pack.pack_format, 61)
})
