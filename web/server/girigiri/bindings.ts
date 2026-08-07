// Girigiri 绑定表：只有用户显式点候选后才写入，全局共享，不把它塞进 tracks.extra。
import { db } from '../db'

export interface GirigiriBinding {
  girigiriId: string
  girigiriName: string
}

const getStmt = db.prepare('SELECT girigiri_id, girigiri_name FROM girigiri_binding WHERE bgm_id = ?')
const upsertStmt = db.prepare(`
  INSERT INTO girigiri_binding (bgm_id, girigiri_id, girigiri_name, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(bgm_id) DO UPDATE SET
    girigiri_id = excluded.girigiri_id,
    girigiri_name = excluded.girigiri_name,
    updated_at = excluded.updated_at
`)

export function getBinding(bgmId: number): GirigiriBinding | null {
  const row = getStmt.get(bgmId) as { girigiri_id: string; girigiri_name: string } | undefined
  return row ? { girigiriId: row.girigiri_id, girigiriName: row.girigiri_name } : null
}

export function putBinding(bgmId: number, girigiriId: string, girigiriName: string): void {
  upsertStmt.run(bgmId, girigiriId, girigiriName, Date.now())
}

export function bindingsFor(bgmIds: number[]): Record<number, GirigiriBinding> {
  if (!bgmIds.length) return {}
  const placeholders = bgmIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT bgm_id, girigiri_id, girigiri_name FROM girigiri_binding WHERE bgm_id IN (${placeholders})`)
    .all(...bgmIds) as { bgm_id: number; girigiri_id: string; girigiri_name: string }[]
  const out: Record<number, GirigiriBinding> = {}
  for (const row of rows) out[row.bgm_id] = { girigiriId: row.girigiri_id, girigiriName: row.girigiri_name }
  return out
}
