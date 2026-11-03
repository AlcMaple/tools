import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { db } from './db'
import { judgeData, versionDir, JudgeDataError } from './order-judge-data'
import { judgeEvents } from './order-judge-events'
import { normalizeBrief, type Brief } from '../shared/order-judge-brief'
import { ATTACH_FILE_RE, ATTACH_MAX_BYTES, ATTACH_MAX_FILES, PROJECT_LIMIT, VERSION_LIMIT } from '../shared/order-judge-api'

// 项目行 + 版本行 + 版本目录里的截图和附件，三样一起备、一起恢复。
// 2026-11 重做前的备份（version 1：能力档案、历史等）结构不同，用户已决定旧数据不要，恢复时跳过
const tables = ['order_judge_projects', 'order_judge_versions'] as const
type Scalar = string | number | null
type Row = Record<string, Scalar>
interface JudgeBackup { version: 2; tables: Record<string, Row[]> }
const ID_RE = /^[0-9a-f-]{36}$/

const fileRefs = (row: Row): string[] => {
  if (typeof row.id !== 'string' || !ID_RE.test(row.id) || typeof row.images !== 'string' || typeof row.files !== 'string') throw new Error('接单评估版本标识无效')
  const images: unknown = JSON.parse(row.images), files: unknown = JSON.parse(row.files)
  if (!Array.isArray(images) || images.length > 40 || !Array.isArray(files) || files.length > ATTACH_MAX_FILES) throw new Error('接单评估文件清单无效')
  for (const i of images) if (!i || typeof i !== 'object' || !/^\d{2}\.jpg$/.test(i.file) || typeof i.name !== 'string') throw new Error('接单评估图片名无效')
  for (const f of files) if (!f || typeof f !== 'object' || !ATTACH_FILE_RE.test(f.file) || typeof f.name !== 'string' || !Number.isSafeInteger(f.size)) throw new Error('接单评估附件名无效')
  return [...images.map(i => (i as { file: string }).file), ...files.map(f => (f as { file: string }).file)]
}

export function collectJudgeBackup(uid: number): { data: JudgeBackup; files: Record<string, Uint8Array> } {
  return db.transaction(() => {
    const data: JudgeBackup = { version: 2, tables: {} }, files: Record<string, Uint8Array> = {}
    let bytes = 0
    for (const table of tables) data.tables[table] = db.prepare(`SELECT * FROM ${table} WHERE user_id=?`).all(uid) as Row[]
    for (const row of data.tables.order_judge_versions) for (const file of fileRefs(row)) {
      const content = readFileSync(join(versionDir(uid, String(row.id)), file)); bytes += content.byteLength
      if (bytes > 200 * 1024 * 1024) throw new JudgeDataError('BACKUP_TOO_LARGE', '接单评估的截图和附件超过 200 MB，请先删掉一些项目', 413)
      files[`order-judge/${row.id}/${file}`] = content
    }
    return { data, files }
  })()
}

export function prepareJudgeRestore(uid: number, raw: unknown, files: Record<string, Uint8Array>): {
  apply(): void; rollback(): void; committed(): void; status(): 'none' | 'restored' | 'existing-skipped'
} {
  const written: string[] = [], folders: string[] = []
  let state: 'none' | 'restored' | 'existing-skipped' = 'none'
  const restored: Record<string, Row[]> = { order_judge_projects: [], order_judge_versions: [] }
  const contents: { path: string; content: Uint8Array }[] = []
  const input = raw as Partial<JudgeBackup> | null | undefined
  if (input?.version === 2) {
    if (!input.tables || typeof input.tables !== 'object') throw new Error('接单评估备份格式无效')
    for (const table of tables) {
      const rows = input.tables[table]
      if (!Array.isArray(rows) || rows.length > PROJECT_LIMIT * VERSION_LIMIT) throw new Error('接单评估备份表无效')
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
      restored[table] = rows.map(rawRow => {
        if (!rawRow || typeof rawRow !== 'object') throw new Error('接单评估备份行无效')
        const row: Row = {}
        for (const column of columns) {
          const value = rawRow[column]
          if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error('接单评估备份字段无效')
          row[column] = column === 'user_id' ? uid : value
        }
        if (typeof row.id !== 'string' || !ID_RE.test(row.id)) throw new Error('接单评估备份标识无效')
        if (table === 'order_judge_versions') {
          row.brief = JSON.stringify(normalizeBrief(JSON.parse(String(row.brief)), JSON.parse(String(row.brief)) as Brief))
          for (const file of fileRefs(row)) {
            const content = files[`order-judge/${row.id}/${file}`]
            const image = file.endsWith('.jpg')
            if (!content || content.length > (image ? 1_500_000 : ATTACH_MAX_BYTES) || image && (content[0] !== 0xff || content[1] !== 0xd8)) throw new Error('备份缺少有效的接单评估截图或附件，请导入完整 ZIP')
            contents.push({ path: join(versionDir(uid, row.id), file), content })
          }
        }
        return row
      })
    }
    if (restored.order_judge_projects.length > PROJECT_LIMIT) throw new Error(`接单评估备份超过 ${PROJECT_LIMIT} 个项目，未静默裁剪`)
  }
  return {
    apply() {
      if (!restored.order_judge_projects.length) return
      // 备份恢复不覆盖已在多端使用的数据；已有项目时保留现状，不走时间戳胜出
      if (db.prepare('SELECT 1 FROM order_judge_projects WHERE user_id=? LIMIT 1').get(uid)) { state = 'existing-skipped'; return }
      for (const item of contents) {
        const folder = dirname(item.path)
        if (!existsSync(folder)) { mkdirSync(folder, { recursive: true }); folders.push(folder) }
        const descriptor = openSync(item.path, 'wx')
        written.push(item.path)
        try { writeFileSync(descriptor, item.content) } finally { closeSync(descriptor) }
      }
      for (const table of tables) for (const row of restored[table]) {
        const columns = Object.keys(row)
        db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]))
      }
      judgeData.bump(uid); state = 'restored'
    },
    rollback() {
      for (const file of written.reverse()) { try { unlinkSync(file) } catch (error) { console.warn('[order-judge] 备份恢复回滚清理失败', error) } }
      for (const folder of folders.reverse()) { try { rmdirSync(folder) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') console.warn('[order-judge] 恢复目录清理失败', error) } }
      state = 'none'
    },
    committed() { if (state === 'restored') judgeEvents.changed(uid, judgeData.seq(uid)) },
    status: () => state,
  }
}
