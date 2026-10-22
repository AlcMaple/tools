import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { db } from './db'
import { dataDir } from './data-dir'
import { judgeData, judgeHash, JudgeDataError } from './order-judge-data'
import { judgeEvents } from './order-judge-events'
import { normalizeReport } from '../shared/order-judge'

// 旧备份里的 versions / bases / conflicts / doc_ops 表已不存在，恢复时忽略。
const tables = ['order_judge_docs', 'order_judge_paths', 'order_judge_history', 'order_judge_runs', 'order_judge_imports'] as const
type Scalar = string | number | null
type Row = Record<string, Scalar>
interface JudgeBackup { version: 1; tables: Record<string, Row[]> }
const location = (uid: number, id: string, file: string): string => join(dataDir, 'order-judge', String(uid), id, file)
const imageRefs = (row: Row): { file: string; name: string }[] => {
  if (typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.id) || typeof row.images !== 'string') throw new Error('接单评估历史标识无效。')
  const images: unknown = JSON.parse(row.images)
  if (!Array.isArray(images) || images.length > 40) throw new Error('接单评估图片清单无效。')
  for (const image of images) if (!image || typeof image !== 'object' || !/^\d{2}\.jpg$/.test(image.file) || typeof image.name !== 'string') throw new Error('接单评估图片名无效。')
  return images as { file: string; name: string }[]
}

export function collectJudgeBackup(uid: number): { data: JudgeBackup; files: Record<string, Uint8Array> } {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM order_judge_runs WHERE user_id=? AND status='running'").get(uid)) throw new JudgeDataError('JUDGE_RUNNING', '评估仍在进行，请结束后再备份。')
    const data: JudgeBackup = { version: 1, tables: {} }, files: Record<string, Uint8Array> = {}
    let bytes = 0
    for (const table of tables) data.tables[table] = db.prepare(`SELECT * FROM ${table} WHERE user_id=?`).all(uid) as Row[]
    if (Buffer.byteLength(JSON.stringify(data)) > 50 * 1024 * 1024) throw new JudgeDataError('BACKUP_TOO_LARGE', '接单评估资料版本超过 50 MB，请先单独归档。', 413)
    for (const row of data.tables.order_judge_history) for (const image of imageRefs(row)) {
      const content = readFileSync(location(uid, String(row.id), image.file)); bytes += content.byteLength
      if (bytes > 200 * 1024 * 1024) throw new JudgeDataError('BACKUP_TOO_LARGE', '历史图片超过 200 MB，请先分批归档。', 413)
      files[`order-judge/${row.id}/${image.file}`] = content
    }
    return { data, files }
  })()
}

export function prepareJudgeRestore(uid: number, raw: unknown, files: Record<string, Uint8Array>): {
  apply(): void; rollback(): void; committed(): void; status(): 'none' | 'restored' | 'existing-skipped'
} {
  const written: string[] = [], folders: string[] = []
  let state: 'none' | 'restored' | 'existing-skipped' = 'none'
  const restored: Record<string, Row[]> = {}
  const images: { path: string; content: Uint8Array }[] = []
  if (raw !== undefined && raw !== null) {
    const input = raw as Partial<JudgeBackup>
    if (input.version !== 1 || !input.tables || typeof input.tables !== 'object') throw new Error('接单评估备份格式无效。')
    for (const table of tables) {
      const rows = input.tables[table]
      if (!Array.isArray(rows) || rows.length > 20_000) throw new Error('接单评估备份表无效。')
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
      restored[table] = rows.map(rawRow => {
        if (!rawRow || typeof rawRow !== 'object') throw new Error('接单评估备份行无效。')
        const row: Row = {}
        for (const column of columns) {
          // 后加的可空列：旧备份里没有这一项，按空值恢复
          const value = column === 'estimate' && !(column in rawRow) ? null : rawRow[column]
          if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error('接单评估备份字段无效。')
          row[column] = column === 'user_id' ? uid : value
        }
        if (row.kind !== undefined && !['profile', 'log'].includes(String(row.kind))) throw new Error('接单评估文档类型无效。')
        if (typeof row.content === 'string' && (Buffer.byteLength(row.content) > 1_000_000 || table === 'order_judge_docs' && row.hash !== judgeHash(row.content))) throw new Error('接单评估正文哈希校验失败。')
        if (row.revision !== undefined && (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1)) throw new Error('接单评估版本无效。')
        if (table === 'order_judge_history') {
          row.report = JSON.stringify(normalizeReport(JSON.parse(String(row.report))))
          if (row.snapshot !== null) {
            const snapshot = JSON.parse(String(row.snapshot)) as { profile?: { hash?: string }; log?: { hash?: string } }
            if (!/^[0-9a-f]{64}$/.test(snapshot.profile?.hash ?? '') || snapshot.log && !/^[0-9a-f]{64}$/.test(snapshot.log.hash ?? '')) throw new Error('接单评估快照无效。')
          }
          for (const image of imageRefs(row)) {
            const content = files[`order-judge/${row.id}/${image.file}`]
            if (!content || content.length > 1_500_000 || content[0] !== 0xff || content[1] !== 0xd8) throw new Error('备份缺少有效的接单评估历史图片，请导入完整 ZIP。')
            images.push({ path: location(uid, String(row.id), image.file), content })
          }
        }
        if (table === 'order_judge_runs' && row.status === 'running') { row.status = 'error'; row.error_code = 'INTERRUPTED'; row.entry_id = null }
        return row
      })
    }
    if (restored.order_judge_history.length > 50) throw new Error('接单评估备份超过 50 条历史，未静默裁剪。')
  }
  return {
    apply() {
      if (!Object.values(restored).some(rows => rows.length)) return
      // 备份恢复不覆盖已在多端使用的版本；已有资料时保留现状，不走时间戳胜出。
      if (tables.some(table => db.prepare(`SELECT 1 FROM ${table} WHERE user_id=? LIMIT 1`).get(uid))) { state = 'existing-skipped'; return }
      for (const image of images) {
        const folder = dirname(image.path)
        if (!existsSync(folder)) { mkdirSync(folder, { recursive: true }); folders.push(folder) }
        const descriptor = openSync(image.path, 'wx')
        written.push(image.path)
        try { writeFileSync(descriptor, image.content) } finally { closeSync(descriptor) }
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
