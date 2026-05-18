/**
 * BGM "本季新番" weekly calendar — pulled from bgm.tv's public API.
 *
 * Endpoint: GET https://api.bgm.tv/calendar
 *   Returns an array of 7 weekday objects. Each weekday has `items[]`, a list
 *   of currently-airing anime that broadcast on that day. The API is
 *   essentially BGM-internal but unauthenticated; it updates whenever bgm.tv's
 *   editors re-curate the season (~quarterly).
 *
 * Caching policy: 24h TTL on disk. The data doesn't change minute-to-minute
 * — fetching it on every page visit would be wasteful and trip BGM's polite-
 * use expectation. The `update` parameter forces a refresh.
 */
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { fetchBgmApiJson } from './api-client'

const CALENDAR_URL = 'https://api.bgm.tv/calendar'
const DAY_MS = 24 * 60 * 60 * 1000
// 番剧周期表一季度更新一次，缓存 14 天和 BGM 搜索结果一致。
// 用户想强制刷新走刷新按钮（update=true）即可。
const CALENDAR_TTL_MS = 14 * DAY_MS

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarItem {
  id: number
  name: string
  name_cn: string
  /** Full BGM subject URL (https://bgm.tv/subject/...). */
  url: string
  /** Cover image (large preferred, falls back through common/medium). */
  cover: string
  /** ISO-ish "YYYY-MM-DD" when known, else empty. */
  airDate: string
  /** Total episode count if BGM knows it; 0 for ongoing-unknown. */
  episodes: number
  /** Bangumi rating 0-10; 0 when not yet rated. */
  score: number
}

export interface CalendarWeekday {
  /** 1-7 — Monday-Sunday in the source data; we keep BGM's convention. */
  id: number
  /** "星期一" / "Mon" / etc — keep the human label closest to the locale. */
  label: string
  items: CalendarItem[]
}

interface CachedCalendar {
  data: CalendarWeekday[]
  updatedAt: number
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function getCachePath(): string {
  return join(app.getPath('userData'), 'bgm_calendar.json')
}

async function readCache(): Promise<CachedCalendar | null> {
  try {
    const p = getCachePath()
    if (!existsSync(p)) return null
    const raw = await fs.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw) as CachedCalendar
    if (!Array.isArray(parsed?.data) || typeof parsed.updatedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

async function writeCache(data: CalendarWeekday[]): Promise<void> {
  try {
    await fs.writeFile(
      getCachePath(),
      JSON.stringify({ data, updatedAt: Date.now() } satisfies CachedCalendar),
      'utf-8',
    )
  } catch {
    /* ignore — calendar is non-essential, next launch will refetch */
  }
}

// ── Parser ────────────────────────────────────────────────────────────────────

function parseCalendar(raw: unknown): CalendarWeekday[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry, idx) => {
    const e = entry as Record<string, unknown>
    const weekday = (e.weekday as Record<string, unknown>) ?? {}
    const id = typeof weekday.id === 'number' ? weekday.id : idx + 1
    // Prefer Chinese label, then English. Fallback to numeric so the UI never
    // shows "undefined" if BGM ever ships a stripped-down response.
    const label =
      (typeof weekday.cn === 'string' && weekday.cn) ||
      (typeof weekday.en === 'string' && weekday.en) ||
      `周 ${id}`

    const itemsRaw = Array.isArray(e.items) ? e.items : []
    const items: CalendarItem[] = itemsRaw.map((iRaw) => {
      const i = iRaw as Record<string, unknown>
      const images = (i.images as Record<string, string>) ?? {}
      const cover = images.large || images.common || images.medium || ''
      const rating = (i.rating as Record<string, unknown>) ?? {}
      return {
        id: typeof i.id === 'number' ? i.id : 0,
        name: String(i.name ?? ''),
        name_cn: String(i.name_cn ?? ''),
        url: String(i.url ?? (i.id ? `https://bgm.tv/subject/${i.id}` : '')),
        cover,
        airDate: String(i.air_date ?? ''),
        episodes: typeof i.eps === 'number' ? i.eps : 0,
        score: typeof rating.score === 'number' ? rating.score : 0,
      }
    })

    return { id, label, items }
  })
}

// ── Public entrypoint ─────────────────────────────────────────────────────────

export interface CalendarResult {
  data: CalendarWeekday[]
  /** ms epoch of when this snapshot was fetched (cache or fresh). */
  updatedAt: number
  /** Whether the result came from disk cache. */
  fromCache: boolean
}

export async function getBgmCalendar(update = false): Promise<CalendarResult> {
  if (!update) {
    const cached = await readCache()
    if (cached && Date.now() - cached.updatedAt < CALENDAR_TTL_MS) {
      return { data: cached.data, updatedAt: cached.updatedAt, fromCache: true }
    }
  }

  try {
    const raw = await fetchBgmApiJson(CALENDAR_URL)
    const data = parseCalendar(raw)
    if (data.length > 0) {
      await writeCache(data)
      return { data, updatedAt: Date.now(), fromCache: false }
    }
    // BGM 返回空数组 —— fallback 到现有缓存（不抛错，因为这是 BGM 那边的问题）
  } catch (err) {
    // **关键区分**：
    //
    // update=true 是用户主动点「刷新」，必须告诉他刷新失败而不是装作成功。
    // 之前这里静默 fallback 到旧缓存，用户点完刷新时间戳没变还以为是 UI
    // 卡了，反复点击反而加重 BGM 限流。
    //
    // update=false 是自动加载（首次进入 / 缓存过期），仍 fallback —— 哪怕
    // 数据稍旧也比白屏强，且首次失败让用户看到 14 天前的缓存是合理体验。
    if (update) throw err
    // 自动加载场景：吞掉错误，下面继续走 cache fallback
  }

  const cached = await readCache()
  if (cached) {
    return { data: cached.data, updatedAt: cached.updatedAt, fromCache: true }
  }
  throw new Error('BGM 周历获取失败，且本地没有缓存')
}
