// 本地动漫索引 —— 追番「搜索加番」的数据源（ideas/012「目录数据源」2026-07-22 定）。
//
// 为什么本地：BGM 在线搜索对「单服务器 IP 高频查询」不友好，一旦把 IP 搞进限流/黑名单，周历和封面
// 代理会一起挂（都靠 BGM）。所以把 BGM 官方**离线数据档**（bangumi/Archive，每周三更新）里 type=2 的
// 动画灌进一个**独立只读**的 `bgm_index.db`，搜索全打本地 → 毫秒级、零 BGM 请求、动漫量=BGM 全量、中文名齐全。
// 索引由 `scripts/build-bgm-index.ts` 生成/重建（原子替换）；封面档里没有，加追番时按老路径拉 detail 补。
//
// 跟 web.db 分开两张库：这张大、只读、可随时整体重建，不该跟用户数据混在一起。
import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../data-dir'

export const indexDbPath = join(dataDir, 'bgm_index.db')

export interface AnimeHit {
  bgmId: number
  name: string // 日文原名
  nameCn: string // 中文译名
  date: string // 放送日期（YYYY-MM-DD，可能空）
  score: number
}

// 只读句柄缓存。索引被重建时是**原子 rename**（换了 inode），旧句柄会一直读到旧文件 —— 所以每次按
// mtime 判断，变了就重开，让搜索读到刚同步的新数据，不必重启服务。
let db: DB | null = null
let dbMtime = 0

function open(): DB | null {
  let mtime = 0
  try {
    mtime = statSync(indexDbPath).mtimeMs
  } catch {
    return null // 索引还没生成（没跑过 build 脚本）
  }
  if (db && mtime === dbMtime) return db
  if (db) {
    try { db.close() } catch { /* ignore */ }
    db = null
  }
  try {
    db = new Database(indexDbPath, { readonly: true, fileMustExist: true })
    dbMtime = mtime
    return db
  } catch {
    db = null
    return null
  }
}

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
 * 搜索动漫 —— 二元组命中，排序：精确 > 前缀 > 整串子串 > 部分命中，同档按「命中片段数」再按 BGM 评分。
 * 约 3 万条动画、字段都短串，全表扫几毫秒，不必上 FTS（真慢了再换 trigram / 预存二元组）。
 */
export function searchAnime(query: string, limit = 30): AnimeHit[] {
  const q = query.trim()
  if (!q) return []
  const h = open()
  if (!h) return []
  const grams = queryGrams(q)
  if (!grams.length) return []

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

  const rows = h
    .prepare(
      `SELECT bgm_id, name, name_cn, date, score FROM anime
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

/** 索引状态 —— 给前端提示「索引就绪 / 还没生成」，以及更新时间。 */
export function indexStatus(): { ready: boolean; count: number; builtAt: number } {
  const h = open()
  if (!h) return { ready: false, count: 0, builtAt: 0 }
  try {
    const c = (h.prepare('SELECT COUNT(*) AS n FROM anime').get() as { n: number }).n
    const m = h.prepare("SELECT v FROM meta WHERE k = 'built_at'").get() as { v: string } | undefined
    return { ready: true, count: c, builtAt: m ? Number(m.v) : 0 }
  } catch {
    return { ready: false, count: 0, builtAt: 0 }
  }
}
