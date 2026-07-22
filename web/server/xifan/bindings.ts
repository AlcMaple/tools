// 稀饭绑定表的读写。表在 db.ts 建（schema 单一真相源）。
//
// 绑定是「全局事实」（bgm→xifan 对所有人一样），故不按用户分：任一用户确认一次，其余人直接命中。
// 只在用户**显式点候选确认**时写（见 xifan.ts 的 /bind），绝不由模糊匹配自动写库。
import { db } from '../db'

export interface Binding {
  xifanId: number
  xifanName: string
}

const getStmt = db.prepare('SELECT xifan_id, xifan_name FROM xifan_binding WHERE bgm_id = ?')
const upsertStmt = db.prepare(`
  INSERT INTO xifan_binding (bgm_id, xifan_id, xifan_name, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(bgm_id) DO UPDATE SET
    xifan_id = excluded.xifan_id, xifan_name = excluded.xifan_name, updated_at = excluded.updated_at
`)

export function getBinding(bgmId: number): Binding | null {
  const r = getStmt.get(bgmId) as { xifan_id: number; xifan_name: string } | undefined
  return r ? { xifanId: r.xifan_id, xifanName: r.xifan_name } : null
}

export function putBinding(bgmId: number, xifanId: number, xifanName: string): void {
  upsertStmt.run(bgmId, xifanId, xifanName, Date.now())
}

/** 一次拿多条 —— 追番页加载时把当前用户所有已绑关系批量取回，绑过的「继续看」直接是链接、无需再定位。 */
export function bindingsFor(bgmIds: number[]): Record<number, Binding> {
  if (!bgmIds.length) return {}
  const placeholders = bgmIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT bgm_id, xifan_id, xifan_name FROM xifan_binding WHERE bgm_id IN (${placeholders})`)
    .all(...bgmIds) as { bgm_id: number; xifan_id: number; xifan_name: string }[]
  const out: Record<number, Binding> = {}
  for (const r of rows) out[r.bgm_id] = { xifanId: r.xifan_id, xifanName: r.xifan_name }
  return out
}
