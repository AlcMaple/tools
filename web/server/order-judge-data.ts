// 接单评估的存取。一份数据是「DB 行 + 磁盘文件」两半：版本的截图和附件落 dataDir/order-judge/<uid>/<版本 id>/，
// 写入先落文件再插行（插行失败删目录），删除先删行再删目录；目录名是随机 UUID，不存在同名文件先删后写的竞态。

import { createHmac } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { db } from './db'
import { dataDir } from './data-dir'
import type { Project, Version } from '../shared/order-judge-api'
import type { Brief, BriefChange } from '../shared/order-judge-brief'
import { AUTH_SECRET } from './secrets'
import { MARKET_WINDOW_MS, marketStats, normalizeQuote, sampleOf, type MarketStat, type SampleRow } from '../shared/order-judge-sheet'
import { normalizeMaintenance } from '../shared/order-judge-maintenance'
import { SCOPE_TTL_MS, type ScopeLink, type ScopeSubmission } from '../shared/order-judge-scope'

export class JudgeDataError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 413 = 409) { super(message) }
}

export const judgeRoot = join(dataDir, 'order-judge')
export const versionDir = (uid: number, id: string): string => join(judgeRoot, String(uid), id)

// 2026-11 重做前的表：能力档案、项目日志、能不能接的历史、工时估价、日薪。用户决定旧数据全部删除
const RETIRED = ['order_judge_docs', 'order_judge_history', 'order_judge_runs', 'order_judge_imports', 'order_judge_settings', 'order_judge_paths']

interface ProjectRow { id: string; title: string; created_at: number; updated_at: number; maintenance: string }
export interface VersionRow { id: string; project_id: string; n: number; at: number; text: string; images: string; files: string; brief: string; changes: string; model: string; quote: string }

interface ScopeRow { project_id: string; token: string; user_id: number; version_id: string; created_at: number; expires_at: number; submission: string | null; submitted_at: number | null; applied_at: number | null }
const rowToScope = (r: ScopeRow): ScopeLink => ({
  token: r.token, versionId: r.version_id, createdAt: r.created_at, expiresAt: r.expires_at, submittedAt: r.submitted_at,
  submission: r.submission ? JSON.parse(r.submission) as ScopeSubmission : null,
})
export interface ScopeTarget { link: ScopeLink; uid: number; projectId: string; appliedAt: number | null; latestVersionId: string | null }

export const rowToVersion = (r: VersionRow): Version => ({
  id: r.id, n: r.n, at: r.at, text: r.text,
  images: JSON.parse(r.images) as Version['images'],
  files: JSON.parse(r.files) as Version['files'],
  brief: JSON.parse(r.brief) as Brief,
  changes: JSON.parse(r.changes) as BriefChange[],
  model: r.model,
  quote: normalizeQuote(JSON.parse(r.quote)),
})

// 样本表和账号、项目都不关联：键是不可逆的散列，用户删除项目时能按版本 id 算出来一起删
const blind = (v: string): string => createHmac('sha256', AUTH_SECRET).update('order-judge-pool:' + v).digest('hex').slice(0, 32)

export class JudgeData {
  constructor(readonly database: Database.Database) {
    const retired = RETIRED.filter(t => database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
    if (retired.length) {
      database.transaction(() => { for (const t of retired) database.exec(`DROP TABLE ${t}`) })()
      rmSync(judgeRoot, { recursive: true, force: true })
      console.info(`[order-judge] 已删除重做前的旧数据：${retired.join(', ')}`)
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS order_judge_changes (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS order_judge_projects (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS order_judge_samples (
        key TEXT PRIMARY KEY, contributor TEXT NOT NULL, client_type TEXT NOT NULL, category TEXT NOT NULL,
        result TEXT NOT NULL, price INTEGER NOT NULL, budget INTEGER, month INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS order_judge_projects_user ON order_judge_projects(user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS order_judge_versions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES order_judge_projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, n INTEGER NOT NULL, at INTEGER NOT NULL,
        text TEXT NOT NULL, images TEXT NOT NULL, files TEXT NOT NULL, brief TEXT NOT NULL, changes TEXT NOT NULL, model TEXT NOT NULL,
        UNIQUE(project_id, n));
      CREATE TABLE IF NOT EXISTS order_judge_scope_links (
        project_id TEXT PRIMARY KEY REFERENCES order_judge_projects(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, version_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, submission TEXT, submitted_at INTEGER, applied_at INTEGER);
    `)
    const columns = (database.prepare('PRAGMA table_info(order_judge_versions)').all() as { name: string }[]).map(c => c.name)
    if (!columns.includes('quote')) database.exec("ALTER TABLE order_judge_versions ADD COLUMN quote TEXT NOT NULL DEFAULT '{}'")
    const projectColumns = (database.prepare('PRAGMA table_info(order_judge_projects)').all() as { name: string }[]).map(c => c.name)
    if (!projectColumns.includes('maintenance')) database.exec("ALTER TABLE order_judge_projects ADD COLUMN maintenance TEXT NOT NULL DEFAULT '{}'")
  }

  seq(uid: number): number {
    return (this.database.prepare('SELECT seq FROM order_judge_changes WHERE user_id=?').get(uid) as { seq: number } | undefined)?.seq ?? 0
  }

  bump(uid: number): void {
    this.database.prepare('INSERT INTO order_judge_changes VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET seq=seq+1').run(uid)
  }

  project(uid: number, id: string): Project | null {
    const row = this.database.prepare('SELECT id,title,created_at,updated_at,maintenance FROM order_judge_projects WHERE id=? AND user_id=?').get(id, uid) as ProjectRow | undefined
    if (!row) return null
    const versions = (this.database.prepare('SELECT * FROM order_judge_versions WHERE project_id=? ORDER BY n').all(id) as VersionRow[]).map(rowToVersion)
    return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, versions, maintenance: normalizeMaintenance(JSON.parse(row.maintenance)), scope: this.scope(id) }
  }

  // 已应用的链接行留着，客户再打开时才能说「已经用过了」而不是「不存在」；对开发者来说它已经关闭
  scope(projectId: string): ScopeLink | null {
    const row = this.database.prepare('SELECT * FROM order_judge_scope_links WHERE project_id=? AND applied_at IS NULL').get(projectId) as ScopeRow | undefined
    return row ? rowToScope(row) : null
  }

  scopeByToken(token: string): ScopeTarget | null {
    const row = this.database.prepare('SELECT * FROM order_judge_scope_links WHERE token=?').get(token) as ScopeRow | undefined
    if (!row) return null
    const latest = this.database.prepare('SELECT id FROM order_judge_versions WHERE project_id=? ORDER BY n DESC LIMIT 1').get(row.project_id) as { id: string } | undefined
    return { link: rowToScope(row), uid: row.user_id, projectId: row.project_id, appliedAt: row.applied_at, latestVersionId: latest?.id ?? null }
  }

  // 每个项目只有一条：重新生成后旧 token 立刻失效，未应用的提交也随之作废
  createScope(uid: number, projectId: string, versionId: string, token: string): void {
    const now = Date.now()
    this.database.prepare('INSERT OR REPLACE INTO order_judge_scope_links (project_id,token,user_id,version_id,created_at,expires_at) VALUES (?,?,?,?,?,?)')
      .run(projectId, token, uid, versionId, now, now + SCOPE_TTL_MS)
  }

  removeScope(uid: number, projectId: string): boolean {
    return this.database.prepare('DELETE FROM order_judge_scope_links WHERE project_id=? AND user_id=?').run(projectId, uid).changes > 0
  }

  submitScope(token: string, submission: ScopeSubmission): number {
    const at = Date.now()
    this.database.prepare('UPDATE order_judge_scope_links SET submission=?, submitted_at=? WHERE token=?').run(JSON.stringify(submission), at, token)
    return at
  }

  closeScope(projectId: string): void {
    this.database.prepare('UPDATE order_judge_scope_links SET applied_at=? WHERE project_id=?').run(Date.now(), projectId)
  }

  projects(uid: number): Project[] {
    const rows = this.database.prepare('SELECT id FROM order_judge_projects WHERE user_id=? ORDER BY updated_at DESC').all(uid) as { id: string }[]
    return rows.map(r => this.project(uid, r.id)!)
  }

  latest(uid: number, projectId: string): Version | null {
    const row = this.database.prepare('SELECT v.* FROM order_judge_versions v JOIN order_judge_projects p ON p.id=v.project_id WHERE p.id=? AND p.user_id=? ORDER BY v.n DESC LIMIT 1').get(projectId, uid) as VersionRow | undefined
    return row ? rowToVersion(row) : null
  }

  // 每次保存报价时同步：最后保存的结果覆盖之前的，结果不再成立就删掉
  syncSample(uid: number, projectId: string, versionId: string): void {
    const project = this.project(uid, projectId)
    const v = project?.versions.find(x => x.id === versionId)
    if (!project || !v) return
    const sample = sampleOf(project.versions, v.n)
    if (!sample) { this.removeSamples([versionId]); return }
    const now = new Date()
    this.database.prepare('INSERT OR REPLACE INTO order_judge_samples VALUES (?,?,?,?,?,?,?,?)')
      .run(blind(versionId), blind('user:' + uid), sample.clientType, sample.category, sample.result, sample.price, sample.budget, Date.UTC(now.getFullYear(), now.getMonth(), 1))
  }

  removeSamples(versionIds: string[]): void {
    for (const id of versionIds) this.database.prepare('DELETE FROM order_judge_samples WHERE key=?').run(blind(id))
  }

  market(): MarketStat[] {
    const rows = this.database.prepare('SELECT contributor, client_type AS clientType, category, result, price, budget FROM order_judge_samples WHERE month>=?').all(Date.now() - MARKET_WINDOW_MS) as SampleRow[]
    return marketStats(rows)
  }

  versionIds(uid: number, projectId: string): string[] {
    return (this.database.prepare('SELECT id FROM order_judge_versions WHERE project_id=? AND user_id=?').all(projectId, uid) as { id: string }[]).map(r => r.id)
  }

  versionFiles(uid: number, versionId: string): { images: Version['images']; files: Version['files'] } | null {
    const row = this.database.prepare('SELECT images,files FROM order_judge_versions WHERE id=? AND user_id=?').get(versionId, uid) as { images: string; files: string } | undefined
    return row ? { images: JSON.parse(row.images) as Version['images'], files: JSON.parse(row.files) as Version['files'] } : null
  }
}

export const judgeData = new JudgeData(db)
