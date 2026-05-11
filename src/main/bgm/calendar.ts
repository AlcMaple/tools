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
import * as https from 'node:https'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const CALENDAR_URL = 'https://api.bgm.tv/calendar'
const DAY_MS = 24 * 60 * 60 * 1000

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

// ── HTTP ──────────────────────────────────────────────────────────────────────

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'tools/1.0 (github.com/user/tools)',
          'Accept': 'application/json',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`))
          res.resume()
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
          catch (e) { reject(e) }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')) })
  })
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
    if (cached && Date.now() - cached.updatedAt < DAY_MS) {
      return { data: cached.data, updatedAt: cached.updatedAt, fromCache: true }
    }
  }

  try {
    const raw = await fetchJson(CALENDAR_URL)
    const data = parseCalendar(raw)
    if (data.length > 0) {
      await writeCache(data)
      return { data, updatedAt: Date.now(), fromCache: false }
    }
    // BGM returned empty — fall through to whatever cache we have, even stale.
  } catch {
    // Network down etc — same fallback.
  }

  const cached = await readCache()
  if (cached) {
    return { data: cached.data, updatedAt: cached.updatedAt, fromCache: true }
  }
  throw new Error('BGM 周历获取失败，且本地没有缓存')
}
