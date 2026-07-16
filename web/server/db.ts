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

// 建表（幂等）。用户名 COLLATE NOCASE → 大小写不敏感唯一（"Bob" 和 "bob" 视为同一个）。
//
// 字段说明：
//   pass_hash            —— scrypt 的 `salt:hash`（见 auth.ts）
//   token_version        —— 改密码 / 重置密码时 +1，签发的 JWT 里带着它，验证时对不上就拒 →
//                           **改密码能真正踢掉所有老会话**（无状态 JWT 默认做不到，加这一列才行）
//   security_question    —— 密保问题的**预设 id**，不是自由文本（预设下拉见 auth.ts SECURITY_QUESTIONS）
//   security_answer_hash —— 密保答案同样走 scrypt 哈希，**绝不存明文**：答案多是真实个人信息、
//                           且用户会跨站复用，DB 一泄露就是直接接管账号
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash            TEXT NOT NULL,
    token_version        INTEGER NOT NULL DEFAULT 0,
    security_question    TEXT,
    security_answer_hash TEXT,
    created_at           TEXT NOT NULL
  );
`)

// 老库补列 —— 沿用 app 那套「零迁移脚本」思路：缺哪列补哪列，不写版本号、不写迁移文件。
function ensureColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`)
}
ensureColumn('users', 'token_version', 'token_version INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'security_question', 'security_question TEXT')
ensureColumn('users', 'security_answer_hash', 'security_answer_hash TEXT')
