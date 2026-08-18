// SQLite 单文件数据层。落在 VPS 的持久磁盘上:同步 API、零网络跳、零额外成本,几十个用户绰绰有余。
//
// **DB 文件位置铁律**:必须放在部署目录之外 —— 见 data-dir.ts(重新部署会清空部署目录)。
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { dataDir } from './data-dir'

export const db = new Database(join(dataDir, 'web.db'))
// WAL:多个浏览器同时读列表 + 偶发写互不阻塞。
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// 建表(幂等)。用户名 COLLATE NOCASE → 大小写不敏感唯一。
//
//   pass_hash             scrypt 的 `salt:hash`;无密码邮箱账号写不可用随机值,由 password_enabled 明确区分
//   password_enabled      1 = 可用用户名 / 密码登录;0 = 只能用邮箱验证码登录
//   email / verified_at   可选的邮箱登录凭据,完成一次性验证码后才写验证时间
//   token_version         改密码 / 重置密码时 +1,JWT 里带着它,验证时对不上就拒 ——
//                         **这是「改密码能踢掉所有老会话」的唯一实现方式**(无状态 JWT 默认做不到)
//   security_question     密保问题的**预设 id**,不是自由文本
//   security_answer_hash  密保答案同样走 scrypt,**绝不存明文**:答案多是真实个人信息且会跨站复用
//                         DB 一泄露就是直接接管账号
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash            TEXT NOT NULL,
    password_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (password_enabled IN (0, 1)),
    email                TEXT,
    email_verified_at    TEXT,
    token_version        INTEGER NOT NULL DEFAULT 0,
    security_question    TEXT,
    security_answer_hash TEXT,
    created_at           TEXT NOT NULL
  );
`)

// 追番表。字段分两类:
//   **瘦列**  网页端自己要查 / 要显示的,单独成列、能索引。
//   **extra** 桌面端独有的富字段原样存 JSON,网页端一个字都不碰,只负责让它原样过服务器往返。
//
//   total_episodes  **NULL = 连载中**,不是 0
//   air_weekday     1~7,用来分「今天更新」组
//   bgm_tags        加追番那一刻锁定,之后不再覆盖
//   aliases         与 bgm_tags 同一次请求拿回来,本地搜索按别名命中要靠它
//   updated_at      毫秒时间戳,同步冲突按「后写者胜」比它
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
    observe_count  INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, bgm_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`)

// BGM 在线搜索候选的共享补充表。只有用户**确实新增追番**时才写，单纯搜索不落库；
// 全局、不按用户分，也不随用户删追番而删。离线 bgm_index.db 每周整体替换，这张表放在
// 持久 web.db 里，既不会被同步覆盖，也能让之后的用户直接复用已确认过的新条目。
db.exec(`
  CREATE TABLE IF NOT EXISTS bgm_search_additions (
    bgm_id  INTEGER PRIMARY KEY,
    name    TEXT    NOT NULL DEFAULT '',
    name_cn TEXT    NOT NULL DEFAULT '',
    aliases TEXT    NOT NULL DEFAULT '[]',
    date    TEXT    NOT NULL DEFAULT '',
    score   REAL    NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL
  );
`)

// 稀饭绑定表 —— bgmId → 站内 id 的映射,「继续看」按钮靠它定位。
//
// **全局、不按用户分**:一个 BGM 条目对应站内哪部番是客观事实,对所有人一样,任一用户确认一次
// 其余人直接命中,所以主键是 bgm_id 而不是 (user_id, bgm_id)。
// 也**不塞进 tracks.extra** —— 那列是留给桌面端富字段原样过路的,绑定是网页端自己的数据,另立一张表干净。
db.exec(`
  CREATE TABLE IF NOT EXISTS xifan_binding (
    bgm_id     INTEGER PRIMARY KEY,
    xifan_id   INTEGER NOT NULL,
    xifan_name TEXT    NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`)

// Girigiri 绑定表,与稀饭同理:全局事实、独立成表。
db.exec(`
  CREATE TABLE IF NOT EXISTS girigiri_binding (
    bgm_id       INTEGER PRIMARY KEY,
    girigiri_id  TEXT    NOT NULL,
    girigiri_name TEXT   NOT NULL DEFAULT '',
    updated_at   INTEGER NOT NULL DEFAULT 0
  );
`)

// 稀饭登录会话 —— 每个 MapleTools 用户独立一份。只保存加密后的 cookie 罐，
// 用户名、密码、验证码都不落库；AUTH_SECRET 同时作为加密密钥的根材料。
db.exec(`
  CREATE TABLE IF NOT EXISTS xifan_session (
    user_id       INTEGER PRIMARY KEY,
    cookie_cipher TEXT    NOT NULL,
    updated_at    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`)

// 老库补列 —— 缺哪列补哪列,不写版本号、不写迁移文件。
function ensureColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`)
}
// 观望次数（status='considering' 时才有意义）。提升为正式列而不是继续躺在 extra 里：
// 网页端现在也要读写它，两处各存一份必然对不上（见 AI_GUIDELINES「一份数据拆成两半」）。
ensureColumn('tracks', 'observe_count', 'observe_count INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'token_version', 'token_version INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'security_question', 'security_question TEXT')
ensureColumn('users', 'security_answer_hash', 'security_answer_hash TEXT')
ensureColumn('users', 'email', 'email TEXT')
ensureColumn('users', 'email_verified_at', 'email_verified_at TEXT')
// 老账号都有真实密码,迁移时统一保持可用;只有新建的邮箱验证码账号显式写 0。
ensureColumn(
  'users',
  'password_enabled',
  'password_enabled INTEGER NOT NULL DEFAULT 1 CHECK (password_enabled IN (0, 1))',
)

// 邮箱是可选凭据:老用户没有,NULL 不参与唯一索引;新用户完成验证码后才写入。
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users (email)
  WHERE email IS NOT NULL;
`)

// 邮箱快捷注册 / 登录的短期挑战。验证码只存 HMAC，不存明文；验证成功后在同一事务内
// 消费 challenge 并查找 / 创建账号，不能拿同一挑战重复建号或登录。
db.exec(`
  CREATE TABLE IF NOT EXISTS email_challenge (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    code_hash    TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    verified_at  INTEGER,
    consumed_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS email_challenge_email_idx
  ON email_challenge (email, created_at DESC);
  CREATE INDEX IF NOT EXISTS email_challenge_expiry_idx
  ON email_challenge (expires_at);
`)

// 第三方登录身份表（**遗留**）—— 登录匹配已改为「邮箱中心」（users.email 是唯一身份，
// Google 只是 Gmail 的免验证码通道，见 server/oauth.ts），本表不再参与任何登录 / 绑定逻辑。
// 保留只为兼容老库；换绑 / 解绑邮箱时会顺带清掉对应旧行（DELETE ... WHERE user_id）。
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_identity (
    provider    TEXT NOT NULL,
    subject     TEXT NOT NULL,
    user_id     INTEGER NOT NULL,
    email       TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (provider, subject),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS oauth_identity_user_idx ON oauth_identity (user_id);
`)

// 追番数据版本号 —— app 的「覆盖上传」靠它判断「服务器上有没有我没见过的改动」。
// **每次写入都 +1**（网页改一条、app 整包推一次，都算）。app 记住上次同步拿到的 rev，上传时带回来：
// 对得上就直接覆盖，对不上就 409 让用户选「先拉取」还是「强制覆盖」。
//
// 为什么不用时间戳比：那要信两端的本地时钟，设备时间不准就会判错方向、静默覆盖掉新数据。
// 递增号只由服务器一家发，跟时钟无关。
ensureColumn('users', 'tracks_rev', 'tracks_rev INTEGER NOT NULL DEFAULT 0')

// 本地上传封面的 MIME —— cover 列存 `local:<bgmId>` 哨兵值时，实际图片文件落在
// data-dir.ts 的 coversDir 下，这一列记它的 Content-Type（服务端流式转发要用）。
ensureColumn('tracks', 'cover_mime', "cover_mime TEXT NOT NULL DEFAULT ''")
