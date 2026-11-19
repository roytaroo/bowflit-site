// セットアップの判定ロジックのテスト
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseModel, serverMemoryGB, bedrockJavaName, patchProperties, patchGeyserConfig, SERVER_PROPERTIES } from '../scripts/setup.js'

test('VRAMに合わせてモデルを選ぶ', () => {
  assert.equal(chooseModel(6144).model, 'qwen2.5:7b-instruct') // GTX 1660 SUPER
  assert.equal(chooseModel(16384).model, 'qwen3:14b')
  assert.equal(chooseModel(16384).concurrency, 3)
  assert.equal(chooseModel(null).model, 'qwen2.5:3b')
})

test('メモリに合わせてサーバーの割り当てを決める', () => {
  assert.equal(serverMemoryGB(8 * 1024 ** 3), 2)
  assert.equal(serverMemoryGB(16 * 1024 ** 3), 3)
  assert.equal(serverMemoryGB(64 * 1024 ** 3), 6)
})

test('統合版の名前 (Floodgate の "." と空白)', () => {
  assert.equal(bedrockJavaName('Daiki 1234'), '.Daiki_1234')
})

test('server.properties: 既存の値を書き換え、無い項目は追加', () => {
  const out = patchProperties('#comment\nonline-mode=true\nmotd=hi\n', SERVER_PROPERTIES)
  assert.match(out, /^#comment$/m)
  assert.match(out, /^online-mode=false$/m)
  assert.match(out, /^server-ip=127\.0\.0\.1$/m)
  assert.equal((out.match(/online-mode=/g) || []).length, 1)
})

test('Geyser: 統合版は Floodgate 認証にする', () => {
  const y = 'remote:\n  address: auto\n  port: 25565\n  auth-type: online\n'
  assert.match(patchGeyserConfig(y), /auth-type: floodgate/)
  assert.equal(patchGeyserConfig(patchGeyserConfig(y)), patchGeyserConfig(y))
})
