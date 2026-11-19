// オフライン検証用の簡易サーバー (flying-squid)。
// 本番は Minecraft Java Edition の公式サーバー / LAN公開ワールドを使う。
// flying-squid は Mob AI・作物成長などが未実装の簡易実装なので「接続と基本操作の確認」専用。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mcServer = require('flying-squid')

const version = process.env.MC_VERSION || '1.21.4'
const port = Number(process.env.MC_PORT || 25565)

mcServer.createMCServer({
  motd: 'AI Society test server',
  port,
  'max-players': 20,
  'online-mode': false,
  logging: false,
  gameMode: 0,
  difficulty: 1,
  worldFolder: undefined,
  generation: { name: 'superflat', options: { worldHeight: 80 } },
  kickTimeout: 60000,
  plugins: {},
  modpe: false,
  'view-distance': 4,
  'player-list-text': { header: 'AI Society', footer: 'test' },
  'everybody-op': true,
  'max-entities': 50,
  version
})
console.log(`[test-server] flying-squid ${version} listening on ${port}`)
