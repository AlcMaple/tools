// 本地动漫索引 —— 追番「搜索加番」的数据源。
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
import { searchAnimeTable } from './anime-search'
import type { AnimeHit } from './anime-search'
import type { EpisodeLayout, SpecialEpisode } from '../../shared/episode-layout'

export type { AnimeHit } from './anime-search'

export const indexDbPath = join(dataDir, 'bgm_index.db')

// 只读句柄缓存。索引被重建时是**原子 rename**（换了 inode），旧句柄会一直读到旧文件 —— 所以每次按
// inode / 大小 / 时间标识判断，变了就重开，让搜索读到刚同步的新数据，不必重启服务。
let db: DB | null = null
let dbMtime = 0
let dbIdentity = ''

export function openOfflineIndex(): DB | null {
  let mtime = 0, identity = ''
  try {
    const stat=statSync(indexDbPath)
    mtime = stat.mtimeMs
    identity = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch {
    return null // 索引还没生成（没跑过 build 脚本）
  }
  if (db && identity === dbIdentity) return db
  if (db) {
    try { db.close() } catch { /* ignore */ }
    db = null
  }
  try {
    db = new Database(indexDbPath, { readonly: true, fileMustExist: true })
    dbMtime = mtime
    dbIdentity = identity
    return db
  } catch {
    db = null
    return null
  }
}

/**
 * 搜索动漫 —— 二元组命中，排序：精确 > 前缀 > 整串子串 > 部分命中，同档按「命中片段数」再按 BGM 评分。
 * 约 3 万条动画、字段都短串，全表扫几毫秒，不必上 FTS（真慢了再换 trigram / 预存二元组）。
 */
export function searchAnime(query: string, limit = 30, year = 0, candidateIds?: readonly number[]): AnimeHit[] {
  if (!query.trim()) return []
  const h = openOfflineIndex()
  if (!h) return []
  return searchAnimeTable(h, 'anime', query, limit, year, candidateIds)
}

function readChapterIndex(h: DB) {
  const cols = h.pragma('table_info(anime)') as { name: string }[]
  const main = cols.some(c => c.name === 'eps') ? h.prepare<[number], {eps: number}>('SELECT eps FROM anime WHERE bgm_id = ?') : null
  const layouts = new Map<number, EpisodeLayout>()
  const grouped = main && cols.some(c => c.name === 'specials')
  if (grouped) {
    const rows = h.prepare<[], {bgm_id: number; eps: number; specials: string}>("SELECT bgm_id, eps, specials FROM anime WHERE specials != '[]'")
    for (const row of rows.iterate()) layouts.set(row.bgm_id, { main: row.eps, specials: JSON.parse(row.specials) as SpecialEpisode[] })
  }
  return { main, layouts, version: grouped ? Math.trunc(dbMtime) : 0 }
}

// 周更索引以 rename 换库。分组只随只读句柄解析一次；老库没有分类时仍可正常追番
const chaptersByIndex = new WeakMap<DB, ReturnType<typeof readChapterIndex>>()
export function chapterIndex() {
  const h = openOfflineIndex()
  if (!h) return null
  let chapters = chaptersByIndex.get(h)
  if (!chapters) chaptersByIndex.set(h, chapters = readChapterIndex(h))
  return chapters
}

// 手帐可记录的总数（正篇 + SP）；0 代表没有章节依据，目录的 eps 列仍只表示正篇
export function epsOf(bgmId: number, reported = 0): number {
  const chapters = chapterIndex()
  const layout = chapters?.layouts.get(bgmId)
  if (layout) return layout.main + layout.specials.length
  const main = chapters?.main?.get(bgmId)?.eps ?? 0
  return chapters?.version ? main || reported : reported || main
}

/** 索引状态 —— 给前端提示「索引就绪 / 还没生成」，以及更新时间。 */
export function indexStatus(): { ready: boolean; count: number; builtAt: number } {
  const h = openOfflineIndex()
  if (!h) return { ready: false, count: 0, builtAt: 0 }
  try {
    const c = (h.prepare('SELECT COUNT(*) AS n FROM anime').get() as { n: number }).n
    const m = h.prepare("SELECT v FROM meta WHERE k = 'built_at'").get() as { v: string } | undefined
    return { ready: true, count: c, builtAt: m ? Number(m.v) : 0 }
  } catch {
    return { ready: false, count: 0, builtAt: 0 }
  }
}
