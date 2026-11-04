// 全部番剧：把离线索引整张表做成可浏览的目录，外加一个慢慢补封面的后台任务。
//
// 离线档里没有封面字段，每部番只能问 BGM 一次 `/v0/subjects/:id` 拿图床路径，再把图下到服务器磁盘
// （cover-proxy 的 bgm-cover-cache）。3 万部番一次拿完会被 BGM 风控，所以：
// - 浏览目录**从不**触发 BGM 请求，没补到封面的卡片就画纸片占位
// - 后台一部一部补，两部之间隔 BACKFILL_GAP_MS，和周历封面共用同一条错峰队列与 429 冷却
// - 遇到 429 / 队列冷却当天就停，第二天再接着补，不在惩罚窗口里探测
// - 结果存 web.db：索引每周整库重建，封面不跟着丢；新入库的番自然排进队尾
import { mkdirSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from '../db'
import { dataDir } from '../data-dir'
import { getBgmCover, noteCoverRateLimit, scheduleBgmCoverRequest } from './cover-proxy'
import { noteBgmRequest } from './bgm-health'
import { openOfflineIndex, searchAnime } from './anime-index'

// 实测口径：约 3 万部 × 2 次请求（条目 + 图片），8 秒一部约 2.8 天补完，远低于 BGM 对单 IP 的容忍度
const BACKFILL_GAP_MS = 8_000
const COVER_WIDTH = 400
const COVER_PATH_RE = /^\/pic\//
// 评分人数门槛：索引里一两个人打出 10 分的番有上百部（多是未播企划和 R18），不设门槛它们就占满第一屏。
// 不够人数的照样列出，只是排在够人数的后面
const MIN_VOTES = 50
const DAY = 86_400_000

db.exec(`
  CREATE TABLE IF NOT EXISTS anime_cover (
    bgm_id     INTEGER PRIMARY KEY,
    path       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL CHECK (status IN ('ok', 'none', 'error')),
    checked_at INTEGER NOT NULL
  );
`)

// 管理员手改的卡片信息。NULL / 空 cover_mime 且空 cover_url = 这一项没改，沿用索引和后台补的封面。
// 上传的封面字节在 catalogCoversDir/<bgm_id>，这张表的 cover_mime 是另一半凭据：两半在每条写路径上同进同退。
// cover_url 是填的网图地址，和上传互斥：换成哪一种，另一种（含磁盘文件）就一起清掉
db.exec(`
  CREATE TABLE IF NOT EXISTS catalog_override (
    bgm_id     INTEGER PRIMARY KEY,
    name_cn    TEXT,
    tags       TEXT,
    cover_mime TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL  -- 封面最后一次换图的时间，也是封面地址里的 ?v=；只改文字不动它，免得浏览器白白重下封面
  );
`)
if (!(db.prepare('PRAGMA table_info(catalog_override)').all() as { name: string }[]).some((c) => c.name === 'cover_url')) {
  db.exec("ALTER TABLE catalog_override ADD COLUMN cover_url TEXT NOT NULL DEFAULT ''")
}
export const catalogCoversDir = join(dataDir, 'catalog-covers')
mkdirSync(catalogCoversDir, { recursive: true })

interface OverrideRow { name_cn: string | null; tags: string | null; cover_mime: string; cover_url: string; updated_at: number }
const overrideRow = db.prepare('SELECT name_cn, tags, cover_mime, cover_url, updated_at FROM catalog_override WHERE bgm_id = ?')

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
  // 只回给管理员：哪几项被手改过，编辑弹窗据此显示「恢复默认」
  edited?: { nameCn: boolean; tags: boolean; cover: boolean }
}

export type CatalogSort = 'score' | 'date'

interface IndexRow { bgm_id: number; name: string; name_cn: string; date: string; score: number; eps?: number; tags: string; adult: number }

function parseTags(raw: string, max: number): string[] {
  try { return (JSON.parse(raw) as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, max) } catch { return [] }
}

function toItem(row: IndexRow, admin: boolean): CatalogItem {
  const ov = overrideRow.get(row.bgm_id) as OverrideRow | undefined
  // R18 条目只给登录用户列出，索引里的标签多是露骨字眼，不展示；封面不去补，管理员手动上传的除外
  const tags = ov?.tags != null ? parseTags(ov.tags, MAX_TAGS) : row.adult ? [] : parseTags(row.tags, 6)
  const cover = ov?.cover_mime ? `/api/catalog/${row.bgm_id}/cover-file?v=${ov.updated_at}`
    : ov?.cover_url ? ov.cover_url
    : row.adult ? '' : (coverRow.get(row.bgm_id) as { path: string } | undefined)?.path ?? ''
  const item: CatalogItem = { bgmId: row.bgm_id, name: row.name, nameCn: ov?.name_cn ?? row.name_cn, date: row.date, score: row.score, eps: Number(row.eps) || 0, tags, cover }
  if (admin) item.edited = { nameCn: ov?.name_cn != null, tags: ov?.tags != null, cover: !!ov?.cover_mime || !!ov?.cover_url }
  return item
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

// R18 条目只列给登录用户，且从不补封面（未登录的 BGM 接口对它们本来就返回 404）。
// 标签过滤一直要带：2026-10-27 的档里有 259 部打了「里番」标签却没标 nsfw。
// nsfw / votes 列是后加的，代码上线到下次周四重建索引之间索引还是旧结构，没有就只靠标签
function visibleSql(): string {
  const tags = `tags NOT LIKE '%"R18"%' AND tags NOT LIKE '%"里番"%' AND tags NOT LIKE '%"18禁"%'`
  return hasColumn('nsfw') ? `nsfw = 0 AND ${tags}` : tags
}

function scoreOrderSql(): string {
  const enough = hasColumn('votes') ? `(votes >= ${MIN_VOTES}) DESC, ` : ''
  return `${enough}score DESC, (date = '') ASC, date DESC`
}

function colsSql(): string {
  return `bgm_id, name, name_cn, date, score, tags${hasColumn('eps') ? ', eps' : ''}, NOT (${visibleSql()}) AS adult`
}

// 管理员保存后回传改好的那一张卡，前端原地替换，不用整页重载丢掉滚动位置
export function getCatalogItem(id: number): CatalogItem | null {
  const h = openOfflineIndex()
  if (!h || !hasAnimeTable()) return null
  const row = h.prepare(`SELECT ${colsSql()} FROM anime WHERE bgm_id = ?`).get(id) as IndexRow | undefined
  return row ? toItem(row, true) : null
}

export function listCatalog(opts: { q: string; year: number; sort: CatalogSort; offset: number; limit: number; adult: boolean; admin: boolean }): { ready: boolean; total: number; items: CatalogItem[]; covered: number; admin: boolean } {
  const h = openOfflineIndex()
  const covered = (countDone.get() as { n: number }).n
  if (!h || !hasAnimeTable()) return { ready: false, total: 0, items: [], covered, admin: opts.admin }
  const visible = visibleSql()
  const cols = colsSql()
  const shown = opts.adult ? '1' : visible
  if (opts.q.trim()) {
    const one = h.prepare(`SELECT ${cols} FROM anime WHERE bgm_id = ? AND ${shown}`)
    const rows = searchAnime(opts.q, 120, opts.year)
      .map((hit) => one.get(hit.bgmId) as IndexRow | undefined)
      .filter((row): row is IndexRow => !!row)
    return { ready: true, total: rows.length, items: rows.slice(opts.offset, opts.offset + opts.limit).map((r) => toItem(r, opts.admin)), covered, admin: opts.admin }
  }
  const where = `WHERE ${shown}${opts.year > 0 ? ' AND substr(date, 1, 4) = ?' : ''}`
  const params: unknown[] = opts.year > 0 ? [String(opts.year)] : []
  // 没有放送日期的条目多是未定档 / 废弃企划，排到最后
  const order = opts.sort === 'date' ? "(date = '') ASC, date DESC, score DESC" : scoreOrderSql()
  const total = (h.prepare(`SELECT COUNT(*) AS n FROM anime ${where}`).get(...params) as { n: number }).n
  const rows = h.prepare(`SELECT ${cols} FROM anime ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, opts.limit, opts.offset) as IndexRow[]
  return { ready: true, total, items: rows.map((r) => toItem(r, opts.admin)), covered, admin: opts.admin }
}

// ── 管理员编辑 ───────────────────────────────────────────────────────────────

export class CatalogEditError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message) }
}

const MAX_TAGS = 10
const COVER_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const COVER_MAX_BYTES = 4 * 1024 * 1024
const coverFile = (id: number): string => join(catalogCoversDir, String(id))

function existsInIndex(id: number): boolean {
  const h = openOfflineIndex()
  return !!h && hasAnimeTable() && !!h.prepare('SELECT 1 FROM anime WHERE bgm_id = ?').get(id)
}

export function isAdultEntry(id: number): boolean {
  const h = openOfflineIndex()
  if (!h || !hasAnimeTable()) return false
  return !!h.prepare(`SELECT 1 FROM anime WHERE bgm_id = ? AND NOT (${visibleSql()})`).get(id)
}

// 同一部番的上传 / 删除按顺序来，否则先发的删除可能晚于后发的上传落盘，把刚传的图删掉
const locks = new Map<number, Promise<unknown>>()
function withLock<T>(id: number, task: () => Promise<T>): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(task)
  locks.set(id, run)
  void run.finally(() => { if (locks.get(id) === run) locks.delete(id) }).catch(() => undefined)
  return run
}

const upsertText = db.prepare(`
  INSERT INTO catalog_override (bgm_id, name_cn, tags, updated_at) VALUES (@id, @name_cn, @tags, @now)
  ON CONFLICT(bgm_id) DO UPDATE SET name_cn = excluded.name_cn, tags = excluded.tags
`)
const dropEmpty = db.prepare("DELETE FROM catalog_override WHERE bgm_id = ? AND name_cn IS NULL AND tags IS NULL AND cover_mime = '' AND cover_url = ''")

// null = 恢复成索引里的；标签按顺序去重，空数组也是一种手改（明确不要任何标签）
export function saveCatalogText(id: number, input: { nameCn: unknown; tags: unknown }): void {
  if (!existsInIndex(id)) throw new CatalogEditError('索引里没有这部番', 404)
  let nameCn: string | null = null
  if (input.nameCn != null) {
    if (typeof input.nameCn !== 'string') throw new CatalogEditError('中文名格式不对')
    nameCn = input.nameCn.trim().slice(0, 120)
  }
  let tags: string | null = null
  if (input.tags != null) {
    if (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== 'string')) throw new CatalogEditError('标签格式不对')
    const list = [...new Set((input.tags as string[]).map((t) => t.trim().slice(0, 20)).filter(Boolean))]
    if (list.length > MAX_TAGS) throw new CatalogEditError(`标签最多 ${MAX_TAGS} 个`)
    tags = JSON.stringify(list)
  }
  db.transaction(() => {
    upsertText.run({ id, name_cn: nameCn, tags, now: Date.now() })
    dropEmpty.run(id)
  })()
}

export async function saveCatalogCover(id: number, file: File): Promise<void> {
  if (!existsInIndex(id)) throw new CatalogEditError('索引里没有这部番', 404)
  if (!COVER_MIME.has(file.type)) throw new CatalogEditError('只支持 PNG / JPEG / WebP / GIF')
  if (file.size > COVER_MAX_BYTES) throw new CatalogEditError('图片不能超过 4MB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  await withLock(id, async () => {
    // 先写临时文件再改名：读取端要么读到旧图、要么读到新图，不会读到写了一半的
    const tmp = `${coverFile(id)}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, coverFile(id))
    db.prepare(`
      INSERT INTO catalog_override (bgm_id, cover_mime, cover_url, updated_at) VALUES (?, ?, '', ?)
      ON CONFLICT(bgm_id) DO UPDATE SET cover_mime = excluded.cover_mime, cover_url = '', updated_at = excluded.updated_at
    `).run(id, file.type, Date.now())
  })
}

const COVER_URL_MAX = 1000

// 只收 https 网图（http 存成 https，和前端 coverUrl 的放行规则一致）；存进去的就是原样地址，
// 显示时照常经 coverUrl 走 lain 代理等分流
export async function saveCatalogCoverUrl(id: number, raw: unknown): Promise<void> {
  if (!existsInIndex(id)) throw new CatalogEditError('索引里没有这部番', 404)
  if (typeof raw !== 'string' || !raw.trim()) throw new CatalogEditError('请填写图片地址')
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new CatalogEditError('图片地址格式不对') }
  if (url.protocol === 'http:') url.protocol = 'https:'
  if (url.protocol !== 'https:' || url.username || url.password) throw new CatalogEditError('图片地址要以 https:// 开头')
  const value = url.toString()
  if (value.length > COVER_URL_MAX) throw new CatalogEditError('图片地址太长')
  await withLock(id, async () => {
    db.prepare(`
      INSERT INTO catalog_override (bgm_id, cover_mime, cover_url, updated_at) VALUES (?, '', ?, ?)
      ON CONFLICT(bgm_id) DO UPDATE SET cover_mime = '', cover_url = excluded.cover_url, updated_at = excluded.updated_at
    `).run(id, value, Date.now())
    await unlinkCover(id)
  })
}

const unlinkCover = (id: number): Promise<void> =>
  unlink(coverFile(id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })

export async function clearCatalogCover(id: number): Promise<void> {
  await withLock(id, async () => {
    db.transaction(() => {
      db.prepare("UPDATE catalog_override SET cover_mime = '', cover_url = '', updated_at = ? WHERE bgm_id = ?").run(Date.now(), id)
      dropEmpty.run(id)
    })()
    await unlinkCover(id)
  })
}

export async function readCatalogCover(id: number): Promise<{ bytes: Buffer; mime: string } | null> {
  const ov = overrideRow.get(id) as OverrideRow | undefined
  if (!ov?.cover_mime) return null
  try {
    return { bytes: await readFile(coverFile(id)), mime: ov.cover_mime }
  } catch (error) {
    console.warn(`[catalog] 手动封面文件读取失败 bgm_id=${id}:`, error)
    return null
  }
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

interface CoverState { status: 'ok' | 'none' | 'error'; path: string; checked_at: number }

// 多久后再问一次 BGM。新番立项时常常还没有海报（记成 none），开播前后又会把先导图换成正式海报，
// 所以放送日期在半年内或还没定的番要定期复查；老番的封面基本不再变，none 也只隔很久再看一眼
function recheckAfter(state: CoverState, date: string, now: number): number {
  if (state.status === 'error') return 7 * DAY
  const airing = !date || Date.parse(date) > now - 180 * DAY
  if (state.status === 'none') return airing ? 14 * DAY : 180 * DAY
  return airing ? 30 * DAY : Infinity
}

// 先补从没问过的，全补过之后再轮到到期复查的；顺序都跟目录默认的评分排序一致，先补用户最先看到的那批
function nextDue(): { id: number; prev: CoverState | undefined } | null {
  const h = openOfflineIndex()
  if (!h || !hasAnimeTable()) return null
  const states = new Map((db.prepare('SELECT bgm_id, status, path, checked_at FROM anime_cover').all() as (CoverState & { bgm_id: number })[]).map((r) => [r.bgm_id, r]))
  const now = Date.now()
  let stale: { id: number; prev: CoverState } | null = null
  for (const row of h.prepare(`SELECT bgm_id, date FROM anime WHERE ${visibleSql()} ORDER BY ${scoreOrderSql()}`).iterate() as Iterable<{ bgm_id: number; date: string }>) {
    const state = states.get(row.bgm_id)
    if (!state) return { id: row.bgm_id, prev: undefined }
    if (!stale && now - state.checked_at > recheckAfter(state, row.date, now)) stale = { id: row.bgm_id, prev: state }
  }
  return stale
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
      const due = nextDue()
      if (due == null) {
        // 补完了；每周索引重建后的新番、到期该复查的番等明天这一轮再接上
        setTimeout(() => void backfillLoop(), msUntilTomorrow())
        return
      }
      const { id, prev } = due
      try {
        const path = await fetchSubjectCover(id)
        if (path) {
          await getBgmCover(path)
          saveCover.run(id, `https://lain.bgm.tv${path}`, 'ok', Date.now())
        } else if (prev?.status === 'ok') {
          // 复查时条目被删 / 改成 R18：保留已有封面，免得卡片从有图退回占位
          saveCover.run(id, prev.path, 'ok', Date.now())
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
        if (prev?.status === 'ok') saveCover.run(id, prev.path, 'ok', Date.now())
        else saveCover.run(id, '', 'error', Date.now())
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
