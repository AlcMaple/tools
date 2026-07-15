// SQLite 单文件 —— 网页版的数据层。落在 VPS（持久磁盘 + root）上，本地 SQLite 最省事：
// 同步 API、零网络跳、零额外成本，≤ 几十个用户绰绰有余（见 ideas/012 待调研 #2）。
//
// **DB 文件位置铁律**：必须放在 `/opt/web`（部署目录）之外 —— 重新部署一条龙会
// `rm -rf /opt/web`，DB 放里面每次部署就清空所有用户。生产用 env `DATA_DIR=/opt/mapletools-data`，
// dev 默认落 `web/data/`（已被 .gitignore 忽略）。
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const dataDir = process.env.DATA_DIR
  ? isAbsolute(process.env.DATA_DIR)
    ? process.env.DATA_DIR
    : join(process.cwd(), process.env.DATA_DIR)
  : join(process.cwd(), 'data')

mkdirSync(dataDir, { recursive: true })

export const db = new Database(join(dataDir, 'web.db'))
// WAL：读写并发更稳（多个浏览器同时读列表 + 偶发写互不阻塞）。
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// 建表（幂等）。用户名 COLLATE NOCASE → 大小写不敏感唯一（"Bob" 和 "bob" 视为同一个），
// 避免用户重名撞车。pass_hash 存 scrypt 的 `salt:hash`（见 auth.ts）。
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash  TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`)
