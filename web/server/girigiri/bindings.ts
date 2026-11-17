// Girigiri 绑定表：只有用户显式点候选后才写入，全局共享，不把它塞进 tracks.extra。
import { db } from '../db'

export interface GirigiriBinding {
  girigiriId: string
  girigiriName: string
  epOffset: number
  // 当前用户追番里这部番的总集数，前端据此给同一合集里的下一部番建议偏移
  episodes?: number | null
}

const getStmt = db.prepare('SELECT girigiri_id, girigiri_name, ep_offset FROM girigiri_binding WHERE bgm_id = ?')
const upsertStmt = db.prepare(`
  INSERT INTO girigiri_binding (bgm_id, girigiri_id, girigiri_name, ep_offset, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(bgm_id) DO UPDATE SET
    girigiri_id = excluded.girigiri_id,
    girigiri_name = excluded.girigiri_name, ep_offset = excluded.ep_offset,
    updated_at = excluded.updated_at
`)

export function getBinding(bgmId: number): GirigiriBinding | null {
  const row = getStmt.get(bgmId) as { girigiri_id: string; girigiri_name: string; ep_offset: number } | undefined
  return row ? { girigiriId: row.girigiri_id, girigiriName: row.girigiri_name, epOffset: row.ep_offset } : null
}

export function putBinding(bgmId: number, girigiriId: string, girigiriName: string, epOffset = 0): void {
  upsertStmt.run(bgmId, girigiriId, girigiriName, epOffset, Date.now())
}

export function bindingsFor(bgmIds: number[]): Record<number, GirigiriBinding> {
  if (!bgmIds.length) return {}
  const placeholders = bgmIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT bgm_id, girigiri_id, girigiri_name, ep_offset FROM girigiri_binding WHERE bgm_id IN (${placeholders})`)
    .all(...bgmIds) as { bgm_id: number; girigiri_id: string; girigiri_name: string; ep_offset: number }[]
  const out: Record<number, GirigiriBinding> = {}
  for (const row of rows) out[row.bgm_id] = { girigiriId: row.girigiri_id, girigiriName: row.girigiri_name, epOffset: row.ep_offset }
  return out
}
