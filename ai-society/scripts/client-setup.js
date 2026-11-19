// Java版の Minecraft ランチャー / クライアント側の自動設定
// - ランチャーにログインしている名前を読み取る
// - ランチャーに「AI Society 1.21.4」の起動構成を追加
// - マルチプレイのサーバー一覧に「AI Society (localhost)」を追加
// 既存ファイルは書き換える前に .bak を残す。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function minecraftDir () {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft')
  return path.join(os.homedir(), '.minecraft')
}

function readJson (f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

function backup (f) { if (fs.existsSync(f) && !fs.existsSync(f + '.bak')) fs.copyFileSync(f, f + '.bak') }

// ランチャーのアカウント情報から Java版のプレイヤー名を探す
export function detectPlayerName (dir = minecraftDir()) {
  for (const file of ['launcher_accounts_microsoft_store.json', 'launcher_accounts.json']) {
    const j = readJson(path.join(dir, file))
    if (!j?.accounts) continue
    const accounts = Object.entries(j.accounts)
    const active = j.activeAccountLocalId && j.accounts[j.activeAccountLocalId]
    const pick = active?.minecraftProfile?.name ? active : accounts.map(([, a]) => a).find(a => a?.minecraftProfile?.name)
    if (pick) return pick.minecraftProfile.name
  }
  return null
}

export function addLauncherProfile (version, dir = minecraftDir()) {
  const f = path.join(dir, 'launcher_profiles.json')
  const j = readJson(f)
  if (!j) return { ok: false, reason: 'launcher_profiles.json が無い (ランチャーを一度起動してログインしてから、もう一度セットアップして)' }
  j.profiles = j.profiles || {}
  const key = 'ai-society-' + version.replace(/\./g, '_')
  if (j.profiles[key]?.lastVersionId === version) return { ok: true, already: true }
  backup(f)
  const now = new Date().toISOString()
  j.profiles[key] = { name: `AI Society ${version}`, type: 'custom', lastVersionId: version, icon: 'Grass', created: now, lastUsed: now }
  fs.writeFileSync(f, JSON.stringify(j, null, 2))
  return { ok: true }
}

export async function addServerEntry (name, ip, dir = minecraftDir()) {
  const nbt = require('prismarine-nbt')
  const f = path.join(dir, 'servers.dat')
  if (!fs.existsSync(dir)) return { ok: false, reason: '.minecraft フォルダが無い (ランチャーで一度ゲームを起動してから)' }
  let root
  if (fs.existsSync(f)) {
    const { parsed } = await nbt.parse(fs.readFileSync(f))
    root = parsed
  } else root = nbt.comp({ servers: nbt.list(nbt.comp([])) })
  root.value.servers = root.value.servers || nbt.list(nbt.comp([]))
  const list = root.value.servers.value
  if (list.type === 'end') { list.type = 'compound'; list.value = [] }
  if (list.value.some(s => s.ip?.value === ip)) return { ok: true, already: true }
  backup(f)
  list.value.unshift({ name: { type: 'string', value: name }, ip: { type: 'string', value: ip } })
  fs.writeFileSync(f, nbt.writeUncompressed(root, 'big'))
  return { ok: true }
}
