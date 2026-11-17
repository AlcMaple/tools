import type { Database } from 'better-sqlite3'

// 来源：bangumi/Archive 的 Subject-relations；只保留两端均已导入的动画，不生成推测的反向关系
export async function importAnimeRelations(db: Database, lines: AsyncIterable<string>, animeIds: Set<number>): Promise<number> {
  db.exec('CREATE TABLE anime_relation (subject_id INTEGER NOT NULL, relation_type INTEGER NOT NULL, related_subject_id INTEGER NOT NULL, sort INTEGER NOT NULL, PRIMARY KEY(subject_id,relation_type,related_subject_id))')
  const insert = db.prepare('INSERT INTO anime_relation VALUES (?,?,?,?) ON CONFLICT(subject_id,relation_type,related_subject_id) DO UPDATE SET sort=MIN(sort,excluded.sort)')
  db.exec('BEGIN')
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const row: unknown = JSON.parse(line)
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('关系记录不是对象')
      const { subject_id: from, relation_type: type, related_subject_id: to, order = 0 } = row as Record<string, unknown>
      if (![from, type, to].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        || typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0) throw new Error('关系记录字段不完整或无效')
      if (from === to || !animeIds.has(from as number) || !animeIds.has(to as number)) continue
      insert.run(from, type, to, order)
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return (db.prepare('SELECT COUNT(*) AS n FROM anime_relation').get() as { n: number }).n
}
