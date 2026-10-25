import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { db } from './db'
import { DOC_MAX_BYTES, type DocKind, type DocMeta, type JudgeDoc, type JudgeDocs, type DocReceipt, type JudgeSnapshot, type JudgePath, type JudgePaths, MAX_JUDGE_PATHS, WEB_DEVICE } from '../shared/order-judge-api'
import { judgeDocText } from '../shared/order-judge-text'

export class JudgeDataError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 413 = 409) { super(message) }
}

export const judgeHash = (text: string): string => createHash('sha256').update(text).digest('hex')
interface DocRow { name: string; content: string; updated_at: number; revision: number; hash: string; source: string | null; source_path: string | null }
interface RunRow { input_hash: string; status: string; entry_id: string | null; error_code: string | null }

export class JudgeData {
  constructor(readonly database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS order_judge_docs (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('profile','log')), name TEXT NOT NULL, content TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,kind));
      CREATE TABLE IF NOT EXISTS order_judge_history (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, report TEXT NOT NULL, order_text TEXT NOT NULL, images TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS order_judge_history_user ON order_judge_history(user_id,at DESC);
      CREATE TABLE IF NOT EXISTS order_judge_changes (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS order_judge_runs (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, status TEXT NOT NULL, entry_id TEXT, error_code TEXT,
        PRIMARY KEY(user_id,request_id));
      CREATE TABLE IF NOT EXISTS order_judge_imports (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL, input_hash TEXT NOT NULL, entry_id TEXT NOT NULL,
        PRIMARY KEY(user_id,source_id));
      CREATE TABLE IF NOT EXISTS order_judge_paths (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('profile','log')),
        position INTEGER NOT NULL, path TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY(user_id,kind,path));
    `)
    const add = (table: string, name: string, definition: string): void => {
      if (!(database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
    }
    add('order_judge_docs', 'revision', 'INTEGER NOT NULL DEFAULT 1')
    add('order_judge_docs', 'hash', "TEXT NOT NULL DEFAULT ''")
    add('order_judge_docs', 'source', 'TEXT')
    add('order_judge_docs', 'source_path', 'TEXT')
    add('order_judge_paths', 'content', 'TEXT')
    add('order_judge_paths', 'updated_at', 'INTEGER')
    add('order_judge_history', 'snapshot', 'TEXT')
    add('order_judge_history', 'model', 'TEXT')
    add('order_judge_history', 'estimate', 'TEXT')
    add('order_judge_history', 'files', 'TEXT')
    database.transaction(() => {
      const rows = database.prepare("SELECT user_id,kind,name,content,updated_at,revision FROM order_judge_docs WHERE hash='' ").all() as (DocRow & { user_id: number; kind: DocKind })[]
      for (const row of rows) {
        const content = judgeDocText(row.content), hash = judgeHash(content)
        database.prepare('UPDATE order_judge_docs SET content=?,hash=? WHERE user_id=? AND kind=?').run(content, hash, row.user_id, row.kind)
      }
      // 服务器只保留两份正文：本机文件是唯一来源，整份覆盖，不再存候选、旧稿和合并基线。
      database.exec('DROP TABLE IF EXISTS order_judge_versions; DROP TABLE IF EXISTS order_judge_conflicts; DROP TABLE IF EXISTS order_judge_bases; DROP TABLE IF EXISTS order_judge_doc_ops')
      database.prepare("UPDATE order_judge_runs SET status='error',error_code='INTERRUPTED' WHERE status='running'").run()
    })()
  }

  seq(uid: number): number {
    return (this.database.prepare('SELECT seq FROM order_judge_changes WHERE user_id=?').get(uid) as { seq: number } | undefined)?.seq ?? 0
  }

  bump(uid: number): void {
    this.database.prepare('INSERT INTO order_judge_changes VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET seq=seq+1').run(uid)
  }

  doc(uid: number, kind: DocKind): JudgeDoc | null {
    const row = this.database.prepare('SELECT * FROM order_judge_docs WHERE user_id=? AND kind=?').get(uid, kind) as DocRow | undefined
    if (!row) return null
    return { name: row.name, content: row.content, revision: row.revision, hash: row.hash, updatedAt: row.updated_at, size: Buffer.byteLength(row.content), source: row.source ?? '网页上传', sourcePath: row.source_path }
  }

  docs(uid: number): JudgeDocs { return { profile: this.doc(uid, 'profile'), log: this.doc(uid, 'log') } }

  meta(uid: number): Record<DocKind, DocMeta | null> {
    const docs = this.docs(uid)
    const meta = (doc: JudgeDoc | null): DocMeta | null => doc ? { name: doc.name, size: doc.size, updatedAt: doc.updatedAt, revision: doc.revision, hash: doc.hash, source: doc.source, sourcePath: doc.sourcePath } : null
    return { profile: meta(docs.profile), log: meta(docs.log) }
  }

  write(uid: number, kind: DocKind, value: unknown): DocReceipt {
    const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const content = typeof input.content === 'string' ? judgeDocText(input.content) : ''
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : ''
    if (!name || !content.trim()) throw new JudgeDataError('BAD_INPUT', '资料为空，没有覆盖云端正文。', 400)
    if (Buffer.byteLength(content) > DOC_MAX_BYTES) throw new JudgeDataError('DOC_TOO_LARGE', '资料超过 1 MB。', 413)
    const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim().slice(0, 60) : '网页上传'
    const path = typeof input.path === 'string' && input.path ? input.path.slice(0, 1024) : null
    return this.database.transaction((): DocReceipt => {
      const current = this.doc(uid, kind), hash = judgeHash(content)
      if (current?.hash === hash && current.name === name && current.sourcePath === path) return { status: 'same', revision: current.revision, hash }
      const revision = (current?.revision ?? 0) + 1
      this.database.prepare(`INSERT INTO order_judge_docs (user_id,kind,name,content,updated_at,revision,hash,source,source_path) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id,kind) DO UPDATE SET name=excluded.name,content=excluded.content,updated_at=excluded.updated_at,revision=excluded.revision,hash=excluded.hash,source=excluded.source,source_path=excluded.source_path`)
        .run(uid, kind, name, content, Date.now(), revision, hash, source, path)
      this.bump(uid)
      return { status: 'saved', revision, hash }
    })()
  }

  paths(uid: number): JudgePaths {
    const rows = this.database.prepare('SELECT kind,path,device,length(CAST(content AS BLOB)) AS size,updated_at FROM order_judge_paths WHERE user_id=? ORDER BY kind,position').all(uid) as { kind: DocKind; path: string; device: string; size: number | null; updated_at: number | null }[]
    const entry = (r: typeof rows[number]): JudgePath => r.size === null ? { path: r.path, device: r.device } : { path: r.path, device: r.device, upload: { size: r.size, updatedAt: r.updated_at ?? 0 } }
    return { profile: rows.filter(r => r.kind === 'profile').map(entry), log: rows.filter(r => r.kind === 'log').map(entry) }
  }

  // 网页（含手机）上传：作为一条「网页」路径存进列表，同名文件替换内容，新文件追加到末尾。
  upload(uid: number, kind: DocKind, value: unknown): void {
    const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const content = typeof input.content === 'string' ? judgeDocText(input.content) : ''
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : ''
    if (!name || !content.trim()) throw new JudgeDataError('BAD_INPUT', '文件是空的，没有上传。', 400)
    if (Buffer.byteLength(content) > DOC_MAX_BYTES) throw new JudgeDataError('DOC_TOO_LARGE', '资料超过 1 MB。', 413)
    this.database.transaction(() => {
      const list = this.paths(uid)[kind], at = Date.now()
      if (list.some(p => p.path === name && p.upload)) {
        this.database.prepare('UPDATE order_judge_paths SET content=?,updated_at=? WHERE user_id=? AND kind=? AND path=?').run(content, at, uid, kind, name)
        // 替换的正好是当前正文的来源：立刻换成新内容。
        if (this.doc(uid, kind)?.sourcePath === name) this.write(uid, kind, { name, content, source: WEB_DEVICE, path: name })
      } else {
        if (list.some(p => p.path === name)) throw new JudgeDataError('BAD_INPUT', '列表里已有同名路径，请先改个文件名。', 400)
        if (list.length >= MAX_JUDGE_PATHS) throw new JudgeDataError('TOO_MANY_PATHS', `每类资料最多 ${MAX_JUDGE_PATHS} 个路径，请先移除不用的。`)
        this.database.prepare('INSERT INTO order_judge_paths (user_id,kind,position,path,device,content,updated_at) VALUES (?,?,?,?,?,?,?)').run(uid, kind, list.length, name, WEB_DEVICE, content, at)
      }
      this.preferUpload(uid, kind)
      this.bump(uid)
    })()
  }

  // 排在当前正文来源之前（或当前正文不来自列表）的第一条网页上传直接成为正文；电脑上的文件只能由那台电脑读到，交给它同步。
  private preferUpload(uid: number, kind: DocKind): void {
    const list = this.paths(uid)[kind], first = list.findIndex(p => p.upload)
    if (first < 0) return
    const source = list.findIndex(p => p.path === this.doc(uid, kind)?.sourcePath)
    if (source !== -1 && source <= first) return
    const row = this.database.prepare('SELECT content FROM order_judge_paths WHERE user_id=? AND kind=? AND path=?').get(uid, kind, list[first].path) as { content: string }
    this.write(uid, kind, { name: list[first].path, content: row.content, source: WEB_DEVICE, path: list[first].path })
  }

  // 网页 / 桌面调整顺序或移除：整表替换。
  setPaths(uid: number, kind: DocKind, value: unknown): JudgePaths {
    const list = parsePaths(value)
    this.database.transaction(() => {
      // 网页上传的正文只在服务器上，调顺序时保留；客户端传不进新的上传内容。
      const kept = new Map((this.database.prepare('SELECT path,content,updated_at FROM order_judge_paths WHERE user_id=? AND kind=? AND content IS NOT NULL').all(uid, kind) as { path: string; content: string; updated_at: number }[]).map(r => [r.path, r]))
      this.database.prepare('DELETE FROM order_judge_paths WHERE user_id=? AND kind=?').run(uid, kind)
      list.forEach((p, i) => {
        const upload = p.device === WEB_DEVICE ? kept.get(p.path) : undefined
        if (p.device === WEB_DEVICE && !upload) throw new JudgeDataError('BAD_INPUT', '网页上传的条目已不存在，请刷新后重试。', 400)
        this.database.prepare('INSERT INTO order_judge_paths (user_id,kind,position,path,device,content,updated_at) VALUES (?,?,?,?,?,?,?)').run(uid, kind, i, p.path, p.device, upload?.content ?? null, upload?.updated_at ?? null)
      })
      this.preferUpload(uid, kind)
      this.bump(uid)
    })()
    return this.paths(uid)
  }

  // 桌面开启共用时把本机路径并进账号：已有的保留原顺序，新的追加到末尾。
  mergePaths(uid: number, value: unknown): JudgePaths {
    const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    this.database.transaction(() => {
      let changed = false
      for (const kind of ['profile', 'log'] as const) {
        const current = this.paths(uid)[kind], known = new Set(current.map(p => p.path))
        const added = parsePaths(input[kind]).filter(p => !known.has(p.path) && p.device !== WEB_DEVICE)
        if (current.length + added.length > MAX_JUDGE_PATHS) throw new JudgeDataError('TOO_MANY_PATHS', `每类资料最多 ${MAX_JUDGE_PATHS} 个路径，请先在评估设置里移除不用的。`)
        added.forEach((p, i) => this.database.prepare('INSERT INTO order_judge_paths (user_id,kind,position,path,device) VALUES (?,?,?,?,?)').run(uid, kind, current.length + i, p.path, p.device))
        changed ||= added.length > 0
      }
      if (changed) this.bump(uid)
    })()
    return this.paths(uid)
  }

  snapshot(uid: number): { profile: string; log: string | null; snapshot: JudgeSnapshot } {
    return this.database.transaction(() => {
      const { profile, log } = this.docs(uid)
      if (!profile) throw new JudgeDataError('NO_PROFILE', '还没有上传能力档案。')
      const ref = (doc: JudgeDoc): { revision: number; hash: string } => ({ revision: doc.revision, hash: doc.hash })
      return { profile: profile.content, log: log?.content ?? null, snapshot: { profile: ref(profile), log: log ? ref(log) : null } }
    })()
  }

  run(uid: number, id: string, hash: string): RunRow | null {
    const row = this.database.prepare('SELECT * FROM order_judge_runs WHERE user_id=? AND request_id=?').get(uid, id) as RunRow | undefined
    if (row && row.input_hash !== hash) throw new JudgeDataError('REQUEST_CHANGED', '同一评估请求的材料发生变化。')
    return row ?? null
  }

  runRow(uid: number, id: string): RunRow | null {
    return (this.database.prepare('SELECT * FROM order_judge_runs WHERE user_id=? AND request_id=?').get(uid, id) as RunRow | undefined) ?? null
  }

  beginRun(uid: number, id: string, hash: string): void {
    this.database.prepare("INSERT INTO order_judge_runs VALUES (?,?,?,'running',NULL,NULL)").run(uid, id, hash)
  }

  endRun(uid: number, id: string, entryId: string | null, code: string | null): void {
    this.database.prepare("UPDATE order_judge_runs SET status=?,entry_id=?,error_code=? WHERE user_id=? AND request_id=? AND status='running'")
      .run(entryId ? 'done' : 'error', entryId, code, uid, id)
  }
}

export const judgeData = new JudgeData(db)

function parsePaths(value: unknown): JudgePath[] {
  if (!Array.isArray(value) || value.length > MAX_JUDGE_PATHS) throw new JudgeDataError('BAD_INPUT', `路径列表无效，每类最多 ${MAX_JUDGE_PATHS} 个。`, 400)
  const seen = new Set<string>()
  return value.map((item): JudgePath => {
    const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    if (typeof p.path !== 'string' || !p.path || p.path.length > 1024 || typeof p.device !== 'string' || !p.device.trim() || p.device.length > 60) throw new JudgeDataError('BAD_INPUT', '路径列表无效。', 400)
    return { path: p.path, device: p.device.trim() }
  }).filter(p => !seen.has(p.path) && Boolean(seen.add(p.path)))
}
