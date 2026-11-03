// 接单评估的存取。一份数据是「DB 行 + 磁盘文件」两半：版本的截图和附件落 dataDir/order-judge/<uid>/<版本 id>/，
// 写入先落文件再插行（插行失败删目录），删除先删行再删目录；目录名是随机 UUID，不存在同名文件先删后写的竞态。

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { db } from './db'
import { dataDir } from './data-dir'
import type { Project, Version } from '../shared/order-judge-api'
import type { Brief, BriefChange } from '../shared/order-judge-brief'
import { normalizeQuote } from '../shared/order-judge-sheet'
import { normalizeMaintenance } from '../shared/order-judge-maintenance'

export class JudgeDataError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 413 = 409) { super(message) }
}

export const judgeRoot = join(dataDir, 'order-judge')
export const versionDir = (uid: number, id: string): string => join(judgeRoot, String(uid), id)

// 2026-11 重做前的表：能力档案、项目日志、能不能接的历史、工时估价、日薪。用户决定旧数据全部删除
const RETIRED = ['order_judge_docs', 'order_judge_history', 'order_judge_runs', 'order_judge_imports', 'order_judge_settings', 'order_judge_paths']

interface ProjectRow { id: string; title: string; created_at: number; updated_at: number; maintenance: string }
export interface VersionRow { id: string; project_id: string; n: number; at: number; text: string; images: string; files: string; brief: string; changes: string; model: string; quote: string }

export const rowToVersion = (r: VersionRow): Version => ({
  id: r.id, n: r.n, at: r.at, text: r.text,
  images: JSON.parse(r.images) as Version['images'],
  files: JSON.parse(r.files) as Version['files'],
  brief: JSON.parse(r.brief) as Brief,
  changes: JSON.parse(r.changes) as BriefChange[],
  model: r.model,
  quote: normalizeQuote(JSON.parse(r.quote)),
})

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
      CREATE INDEX IF NOT EXISTS order_judge_projects_user ON order_judge_projects(user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS order_judge_versions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES order_judge_projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, n INTEGER NOT NULL, at INTEGER NOT NULL,
        text TEXT NOT NULL, images TEXT NOT NULL, files TEXT NOT NULL, brief TEXT NOT NULL, changes TEXT NOT NULL, model TEXT NOT NULL,
        UNIQUE(project_id, n));
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
    return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, versions, maintenance: normalizeMaintenance(JSON.parse(row.maintenance)) }
  }

  projects(uid: number, limit: number): Project[] {
    const rows = this.database.prepare('SELECT id FROM order_judge_projects WHERE user_id=? ORDER BY updated_at DESC LIMIT ?').all(uid, limit) as { id: string }[]
    return rows.map(r => this.project(uid, r.id)!)
  }

  latest(uid: number, projectId: string): Version | null {
    const row = this.database.prepare('SELECT v.* FROM order_judge_versions v JOIN order_judge_projects p ON p.id=v.project_id WHERE p.id=? AND p.user_id=? ORDER BY v.n DESC LIMIT 1').get(projectId, uid) as VersionRow | undefined
    return row ? rowToVersion(row) : null
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
