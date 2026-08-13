/**
 * BGM「本季新番」周历,来自 bgm.tv 的公开接口。
 *
 * `GET https://api.bgm.tv/calendar` 返回 7 个星期几对象,每个带当天放送的番剧列表。
 * 这个接口不需要鉴权,内容一个季度才换一次。
 *
 * 所以缓存 TTL 给得很长:数据不会分钟级变化,每次进页面都拉既浪费也不礼貌。用户想强制刷新
 * 走刷新按钮(update=true)。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { fetchBgmApiJson } from './api-client'

const CALENDAR_URL = 'https://api.bgm.tv/calendar'
const DAY_MS = 24 * 60 * 60 * 1000
// 周期表一个季度更新一次,缓存时长与 BGM 搜索结果一致。
const CALENDAR_TTL_MS = 14 * DAY_MS

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarItem {
  id: number
  name: string
  name_cn: string
  /** BGM 条目页完整 URL。 */
  url: string
  /** 封面图(优先大图,依次回落)。 */
  cover: string
  /** 已知时为 "YYYY-MM-DD",未知为空串。 */
  airDate: string
  /** BGM 知道总集数时给出;连载中未知为 0。 */
  episodes: number
  /** 评分 0~10,还没评分时为 0。 */
  score: number
}

export interface CalendarWeekday {
  /** 1~7 对应周一到周日,沿用 BGM 的约定。 */
  id: number
  /** 人类可读的星期标签,保留最贴近本地语言的那一个。 */
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
    // 文件不存在时 readFile 直接抛 ENOENT、被 catch 接住返回 null —— 不必再多一次同步 stat。
    const raw = await fs.readFile(getCachePath(), 'utf-8')
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
    // 优先中文标签,其次英文;都没有就用数字兜底,保证 UI 永远有东西显示。
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
