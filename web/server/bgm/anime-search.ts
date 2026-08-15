import type { Database as DB } from 'better-sqlite3'

export interface AnimeHit {
  bgmId: number
  name: string // 日文原名
  nameCn: string // 中文译名
  date: string // 放送日期（YYYY-MM-DD，可能空）
  score: number
}

export type AnimeSearchTable = 'anime' | 'bgm_search_additions'

// 转义 LIKE 的通配符，避免用户输入里的 % _ 当成通配（也顺手挡注入）
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => '\\' + m)

/**
 * 把查询拆成「匹配片段」：拉丁/数字连续词整段；CJK 拆**相邻二元组**（漫画咖啡厅 → 漫画,画咖,咖啡,啡厅）。
 * 这样搜「漫画咖啡厅」也能命中「漫画咖啡屋」—— 共享 漫画/画咖/咖啡 三个二元组，靠命中数排上来（≈ BGM 的模糊搜）。
 * 纯 LIKE 是「一字不差的整串子串」，差一个字就搜不到；二元组把它拆软，是这次的关键。
 */
function queryGrams(q: string): string[] {
  const out = new Set<string>()
  for (const w of q.match(/[a-z0-9]+/gi) ?? []) if (w.length >= 2) out.add(w.toLowerCase())
  const cjk = q.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ' ')
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue
    if (seg.length === 1) out.add(seg)
    else for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
  }
  return [...out].slice(0, 16) // 上限防超长粘贴拼出巨型 SQL
}

/**
 * 在同构的动漫表里搜索 —— 二元组命中，排序：精确 > 前缀 > 整串子串 > 部分命中，
 * 同档按「命中片段数」再按 BGM 评分。表名只允许两张已知表，不能由请求参数拼 SQL。
 */
export function searchAnimeTable(
  db: DB,
  table: AnimeSearchTable,
  query: string,
  limit = 30,
): AnimeHit[] {
  const q = query.trim()
  if (!q) return []
  const grams = queryGrams(q)
  if (!grams.length) return []
  if (table !== 'anime' && table !== 'bgm_search_additions') {
    throw new Error(`不支持的动漫搜索表：${String(table)}`)
  }

  // 每个片段在 name / name_cn / aliases 任一命中就算一次；命中越多越相关
  const anyCol = (p: string): string =>
    `(name LIKE @${p} ESCAPE '\\' OR name_cn LIKE @${p} ESCAPE '\\' OR aliases LIKE @${p} ESCAPE '\\')`
  const params: Record<string, string | number> = {
    limit,
    exact: q,
    prefix: escapeLike(q) + '%',
    full: '%' + escapeLike(q) + '%',
  }
  const gramConds = grams.map((g, i) => {
    params[`g${i}`] = '%' + escapeLike(g) + '%'
    return anyCol(`g${i}`)
  })
  const hits = gramConds.map((c) => `(${c})`).join(' + ')

  const rows = db
    .prepare(
      `SELECT bgm_id, name, name_cn, date, score FROM ${table}
       WHERE ${gramConds.join(' OR ')}
       ORDER BY
         (CASE WHEN name_cn = @exact OR name = @exact THEN 3
               WHEN name_cn LIKE @prefix ESCAPE '\\' OR name LIKE @prefix ESCAPE '\\' THEN 2
               WHEN ${anyCol('full')} THEN 1 ELSE 0 END) DESC,
         (${hits}) DESC,
         score DESC
       LIMIT @limit`
    )
    .all(params) as { bgm_id: number; name: string; name_cn: string; date: string; score: number }[]
  return rows.map((r) => ({ bgmId: r.bgm_id, name: r.name, nameCn: r.name_cn, date: r.date, score: r.score }))
}
