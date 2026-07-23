// SQLite 单文件 —— 网页版的数据层。落在 VPS（持久磁盘 + root）上，本地 SQLite 最省事：
// 同步 API、零网络跳、零额外成本，≤ 几十个用户绰绰有余（见 ideas/012 待调研 #2）。
//
// **DB 文件位置铁律**：必须放在 `/opt/web`（部署目录）之外 —— 见 data-dir.ts。
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { dataDir } from './data-dir'

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

// 追番表。
//
// 字段分两类（见 ideas/012「同步策略」）：
//   **瘦列** —— web 自己要查 / 要显示的（status / episode / 标题 / 封面 / 标签…），单独成列，能索引。
//   **extra** —— app 独有的富字段（goodEpisodes / bindings / novel 进度…）原样存 JSON。web 一个字
//                都不碰，只负责让它原样过服务器往返。**现在还没有同步，这列先空着** —— 但列先建好，
//                将来接同步不用改表。
//
//   total_episodes —— **NULL = 连载中**（跟 app 的 `totalEpisodes == null` 同语义），不是 0
//   air_weekday    —— 1-7，用来分「今天更新」组
//   bgm_tags       —— 来自 BGM，加追番那一刻锁定，之后不再覆盖（跟 app 的 lock-on-first-content 一致）
//   aliases        —— 跟 bgm_tags 同一次 detail 请求拿回来，本地搜索按别名命中要靠它
//   updated_at     —— 毫秒时间戳。将来同步冲突按「后写者胜」比这个
db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL,
    bgm_id         INTEGER NOT NULL,
    status         TEXT    NOT NULL DEFAULT 'watching',
    episode        INTEGER NOT NULL DEFAULT 0,
    total_episodes INTEGER,
    title          TEXT    NOT NULL DEFAULT '',
    title_cn       TEXT    NOT NULL DEFAULT '',
    cover          TEXT    NOT NULL DEFAULT '',
    air_weekday    INTEGER NOT NULL DEFAULT 0,
    air_date       TEXT    NOT NULL DEFAULT '',
    score          REAL    NOT NULL DEFAULT 0,
    bgm_tags       TEXT    NOT NULL DEFAULT '[]',
    user_tags      TEXT    NOT NULL DEFAULT '[]',
    aliases        TEXT    NOT NULL DEFAULT '[]',
    extra          TEXT    NOT NULL DEFAULT '{}',
    updated_at     INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, bgm_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`)

// 稀饭绑定表 —— bgmId → 稀饭 animeId 的映射，「继续看」按钮靠它定位（见 xifan/locate.ts）。
//
// **全局、不按用户分**：bgm 主题 → 稀饭番剧是「客观事实」，对所有人一样，任一用户确认一次其余人直接命中。
// 故主键是 bgm_id 而非 (user_id, bgm_id)。也**不塞进 tracks.extra**：那列是留给 app 富字段原样过路的
// （见上），web 一个字都不该碰它 —— 绑定是 web 自己的数据，另立一张表干净。
//   xifan_name —— 存一份匹配到的中文名，前端播放页 / 换绑时显示，好让用户一眼看出绑没绑错。
db.exec(`
  CREATE TABLE IF NOT EXISTS xifan_binding (
    bgm_id     INTEGER PRIMARY KEY,
    xifan_id   INTEGER NOT NULL,
    xifan_name TEXT    NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
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

// 追番数据版本号 —— app 的「覆盖上传」靠它判断「服务器上有没有我没见过的改动」（ideas/012 追番同步）。
// **每次写入都 +1**（网页改一条、app 整包推一次，都算）。app 记住上次同步拿到的 rev，上传时带回来：
// 对得上就直接覆盖，对不上就 409 让用户选「先拉取」还是「强制覆盖」。
//
// 为什么不用时间戳比：那要信两端的本地时钟，设备时间不准就会判错方向、静默覆盖掉新数据。
// 递增号只由服务器一家发，跟时钟无关。
ensureColumn('users', 'tracks_rev', 'tracks_rev INTEGER NOT NULL DEFAULT 0')
