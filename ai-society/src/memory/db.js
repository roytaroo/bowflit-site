// 永続ストレージ (SQLite)。Node.js 組み込みの node:sqlite を使うのでネイティブビルド不要。
// 9人の記憶が混ざらないよう、個人データはすべて agent 列でキーを分けている。
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  alive INTEGER NOT NULL DEFAULT 1,
  home TEXT,                 -- JSON {x,y,z}
  current_goal TEXT,
  long_goal TEXT,
  growth TEXT DEFAULT '',    -- 経験で変化した価値観・考え方 (可変人格)
  caution INTEGER NOT NULL DEFAULT 0, -- 死亡/失敗で上がる慎重さ (安全管理が参照)
  deaths INTEGER NOT NULL DEFAULT 0,
  last_diary_day INTEGER NOT NULL DEFAULT -1,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,        -- event/chat/fact/success/failure/lesson/goal/reflection/summary/death
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 3, -- 1..10
  about TEXT,                -- 関係する相手の名前 (任意)
  day INTEGER,
  created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mem_agent ON memories(agent, archived, created_at);
CREATE TABLE IF NOT EXISTS shared_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,        -- death/build/expedition/meeting/history/join
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  participants TEXT,         -- JSON array
  day INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relationships (
  agent TEXT NOT NULL,
  other TEXT NOT NULL,
  label TEXT,                -- 親友/ライバル/師匠 など (LLMや初期設定が書く)
  affinity INTEGER NOT NULL DEFAULT 0,  -- -100..100 好き嫌い
  trust INTEGER NOT NULL DEFAULT 0,     -- -100..100 信頼
  impression TEXT DEFAULT '',           -- 言葉で書いた印象 (数値より優先してプロンプトに入る)
  updated_at INTEGER,
  PRIMARY KEY (agent, other)
);
CREATE TABLE IF NOT EXISTS relationship_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  other TEXT NOT NULL,
  event TEXT NOT NULL,       -- 実際の出来事 (関係変化の根拠)
  d_affinity INTEGER NOT NULL DEFAULT 0,
  d_trust INTEGER NOT NULL DEFAULT 0,
  day INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS diaries (
  agent TEXT NOT NULL,
  day INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent, day)
);
CREATE TABLE IF NOT EXISTS deaths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  cause TEXT,
  x REAL, y REAL, z REAL,
  dimension TEXT,
  day INTEGER,
  permanent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS graves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  for_agent TEXT NOT NULL,
  death_id INTEGER,
  x INTEGER, y INTEGER, z INTEGER,
  epitaph TEXT,
  built_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,        -- grave/house/wall/road/expedition/festival/other
  title TEXT NOT NULL,
  detail TEXT,
  proposed_by TEXT,
  members TEXT DEFAULT '[]', -- JSON array
  status TEXT NOT NULL DEFAULT 'open', -- open/doing/done/cancelled
  target TEXT,               -- JSON (墓なら対象者など)
  day INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS promises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open/kept/broken
  day INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS protected_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT,
  kind TEXT,                 -- home/grave/room
  x INTEGER, y INTEGER, z INTEGER,
  radius INTEGER NOT NULL DEFAULT 6
);
CREATE TABLE IF NOT EXISTS world_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
`

export class Store {
  constructor (file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  run (sql, ...params) { return this.db.prepare(sql).run(...params) }
  get (sql, ...params) { return this.db.prepare(sql).get(...params) }
  all (sql, ...params) { return this.db.prepare(sql).all(...params) }

  // ---- agents ----
  ensureAgent (name, defaults = {}) {
    const row = this.get('SELECT * FROM agents WHERE name = ?', name)
    if (row) return row
    this.run('INSERT INTO agents (name, long_goal, updated_at) VALUES (?, ?, ?)', name, defaults.long_goal || null, Date.now())
    return this.get('SELECT * FROM agents WHERE name = ?', name)
  }

  getAgent (name) { return this.get('SELECT * FROM agents WHERE name = ?', name) }

  updateAgent (name, fields) {
    const keys = Object.keys(fields)
    if (!keys.length) return
    const sets = keys.map(k => `${k} = ?`).join(', ')
    const vals = keys.map(k => (fields[k] !== null && typeof fields[k] === 'object') ? JSON.stringify(fields[k]) : fields[k])
    this.run(`UPDATE agents SET ${sets}, updated_at = ? WHERE name = ?`, ...vals, Date.now(), name)
  }

  // ---- world state ----
  getState (key, fallback = null) {
    const r = this.get('SELECT value FROM world_state WHERE key = ?', key)
    return r ? JSON.parse(r.value) : fallback
  }

  setState (key, value) {
    this.run('INSERT INTO world_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
  }

  close () { this.db.close() }
}
