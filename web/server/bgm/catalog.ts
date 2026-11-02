// 全部番剧：把离线索引整张表做成可浏览的目录，外加一个慢慢补封面的后台任务。
//
// 离线档里没有封面字段，每部番只能问 BGM 一次 `/v0/subjects/:id` 拿图床路径，再把图下到服务器磁盘
// （cover-proxy 的 bgm-cover-cache）。3 万部番一次拿完会被 BGM 风控，所以：
// - 浏览目录**从不**触发 BGM 请求，没补到封面的卡片就画纸片占位
// - 后台一部一部补，两部之间隔 BACKFILL_GAP_MS，和周历封面共用同一条错峰队列与 429 冷却
// - 遇到 429 / 队列冷却当天就停，第二天再接着补，不在惩罚窗口里探测
// - 结果存 web.db：索引每周整库重建，封面不跟着丢；新入库的番自然排进队尾
import { db } from '../db'
import { getBgmCover, noteCoverRateLimit, scheduleBgmCoverRequest } from './cover-proxy'
import { noteBgmRequest } from './bgm-health'
import { openOfflineIndex, searchAnime } from './anime-index'

// 实测口径：约 3 万部 × 2 次请求（条目 + 图片），8 秒一部约 2.8 天补完，远低于 BGM 对单 IP 的容忍度
const BACKFILL_GAP_MS = 8_000
const COVER_WIDTH = 400
const COVER_PATH_RE = /^\/pic\//

db.exec(`
  CREATE TABLE IF NOT EXISTS anime_cover (
    bgm_id     INTEGER PRIMARY KEY,
    path       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL CHECK (status IN ('ok', 'none', 'error')),
    checked_at INTEGER NOT NULL
  );
`)

const coverRow = db.prepare('SELECT path FROM anime_cover WHERE bgm_id = ? AND status = \'ok\'')
const saveCover = db.prepare(`
  INSERT INTO anime_cover (bgm_id, path, status, checked_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(bgm_id) DO UPDATE SET path = excluded.path, status = excluded.status, checked_at = excluded.checked_at
`)
const countDone = db.prepare('SELECT COUNT(*) AS n FROM anime_cover WHERE status = \'ok\'')

export interface CatalogItem {
  bgmId: number
  name: string
  nameCn: string
  date: string
  score: number
  eps: number
  tags: string[]
  cover: string
}

export type CatalogSort = 'score' | 'date'

interface IndexRow { bgm_id: number; name: string; name_cn: string; date: string; score: number; eps?: number; tags: string }

function toItem(row: IndexRow): CatalogItem {
  let tags: string[] = []
  try { tags = (JSON.parse(row.tags) as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 6) } catch { tags = [] }
  const cover = (coverRow.get(row.bgm_id) as { path: string } | undefined)?.path ?? ''
  return { bgmId: row.bgm_id, name: row.name, nameCn: row.name_cn, date: row.date, score: row.score, eps: Number(row.eps) || 0, tags, cover }
}

// 索引文件可能存在但是空的（构建中断 / 新机器上的占位文件），当成「还没整理好」，别让查询 500
function hasAnimeTable(): boolean {
  const h = openOfflineIndex()
  return !!h && !!h.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'anime'").get()
}

function hasColumn(name: string): boolean {
  const h = openOfflineIndex()
  if (!h) return false
  return (h.prepare('PRAGMA table_info(anime)').all() as { name: string }[]).some((c) => c.name === name)
}

export function listCatalog(opts: { q: string; year: number; sort: CatalogSort; offset: number; limit: number }): { ready: boolean; total: number; items: CatalogItem[]; covered: number } {
  const h = openOfflineIndex()
  const covered = (countDone.get() as { n: number }).n
  if (!h || !hasAnimeTable()) return { ready: false, total: 0, items: [], covered }
  const cols = `bgm_id, name, name_cn, date, score, tags${hasColumn('eps') ? ', eps' : ''}`
  if (opts.q.trim()) {
    const ids = searchAnime(opts.q, 120).map((hit) => hit.bgmId)
    const rows = ids.slice(opts.offset, opts.offset + opts.limit)
      .map((id) => h.prepare(`SELECT ${cols} FROM anime WHERE bgm_id = ?`).get(id) as IndexRow | undefined)
      .filter((row): row is IndexRow => !!row)
    return { ready: true, total: ids.length, items: rows.map(toItem), covered }
  }
  const where = opts.year > 0 ? 'WHERE substr(date, 1, 4) = ?' : ''
  const params: unknown[] = opts.year > 0 ? [String(opts.year)] : []
  // 没有放送日期的条目多是未定档 / 废弃企划，排到最后
  const order = opts.sort === 'date' ? "(date = '') ASC, date DESC, score DESC" : "score DESC, (date = '') ASC, date DESC"
  const total = (h.prepare(`SELECT COUNT(*) AS n FROM anime ${where}`).get(...params) as { n: number }).n
  const rows = h.prepare(`SELECT ${cols} FROM anime ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, opts.limit, opts.offset) as IndexRow[]
  return { ready: true, total, items: rows.map(toItem), covered }
}

// ── 后台补封面 ───────────────────────────────────────────────────────────────

class RateLimited extends Error {}

async function fetchSubjectCover(id: number): Promise<string> {
  return scheduleBgmCoverRequest(async () => {
    const url = `https://api.bgm.tv/v0/subjects/${id}`
    let response: Response
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)' },
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      noteBgmRequest(url, null)
      throw error
    }
    noteBgmRequest(url, response.status)
    if (response.status === 429) {
      noteCoverRateLimit()
      await response.body?.cancel()
      throw new RateLimited('BGM HTTP 429')
    }
    if (response.status === 404) { await response.body?.cancel(); return '' }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`BGM HTTP ${response.status}`)
    }
    const data = await response.json() as { images?: { common?: string; large?: string } }
    const raw = data.images?.large || data.images?.common || ''
    if (!raw) return ''
    const pic = new URL(raw)
    if (pic.hostname !== 'lain.bgm.tv') return ''
    const m = pic.pathname.match(/\/pic\/.*/)
    return m && COVER_PATH_RE.test(m[0]) ? `/r/${COVER_WIDTH}${m[0]}` : ''
  })
}

function nextMissing(): number | null {
  const h = openOfflineIndex()
  if (!h || !hasAnimeTable()) return null
  // 网络失败的条目一周后再试一次；没有封面（none）的不再问
  const done = new Set((db.prepare("SELECT bgm_id FROM anime_cover WHERE status != 'error' OR checked_at > ?").all(Date.now() - 7 * 86_400_000) as { bgm_id: number }[]).map((r) => r.bgm_id))
  // 目录默认按评分排，先补用户最先看到的那批
  for (const row of h.prepare("SELECT bgm_id FROM anime ORDER BY score DESC, (date = '') ASC, date DESC").iterate() as Iterable<{ bgm_id: number }>) {
    if (!done.has(row.bgm_id)) return row.bgm_id
  }
  return null
}

let running = false

function msUntilTomorrow(): number {
  const next = new Date()
  next.setHours(24, 5, 0, 0)
  return next.getTime() - Date.now()
}

async function backfillLoop(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      const id = nextMissing()
      if (id == null) {
        // 补完了；每周索引重建后的新番等明天这一轮再接上
        setTimeout(() => void backfillLoop(), msUntilTomorrow())
        return
      }
      try {
        const path = await fetchSubjectCover(id)
        if (path) {
          await getBgmCover(path)
          saveCover.run(id, `https://lain.bgm.tv${path}`, 'ok', Date.now())
        } else {
          saveCover.run(id, '', 'none', Date.now())
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof RateLimited || /rate limited|queue full/.test(message)) {
          console.warn(`[catalog] 补封面暂停到明天：${message}（bgm_id=${id}）`)
          setTimeout(() => void backfillLoop(), msUntilTomorrow())
          return
        }
        console.warn(`[catalog] 补封面失败 bgm_id=${id}:`, error)
        saveCover.run(id, '', 'error', Date.now())
      }
      await new Promise((resolve) => setTimeout(resolve, BACKFILL_GAP_MS))
    }
  } finally {
    running = false
  }
}

export function startCatalogCoverBackfill(): void {
  if (process.env.CATALOG_COVER_BACKFILL === '0') return
  // 启动后先让周历、追番这些前台请求走完再开始
  setTimeout(() => void backfillLoop(), 60_000)
}
