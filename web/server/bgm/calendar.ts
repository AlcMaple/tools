// 从 app 的 src/main/bgm/calendar.ts 拷来 —— 解析逻辑（parseCalendar）原样保留，只换传输层
// （Electron net → fetch）+ 缓存（磁盘 → 进程内内存，serverless 无持久盘）。app 那边一行不动
// （见 012「抓取复用策略」）。
import { fetchJson } from '../http'

const CALENDAR_URL = 'https://api.bgm.tv/calendar'

// BGM 官方要求第三方调 api.bgm.tv **老实自报家门**（别用浏览器伪装 UA，那样更易被风控）。
const BGM_HEADERS = {
  'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)',
  Accept: 'application/json',
}

export interface CalendarItem {
  id: number
  name: string
  name_cn: string
  url: string
  cover: string
  airDate: string
  episodes: number
  score: number
}

export interface CalendarWeekday {
  id: number
  label: string
  items: CalendarItem[]
}

// 图片 / 链接一律升到 https —— 网页版跑在 https 下，BGM 返回的 http 资源会被浏览器当
// 「混合内容」拦掉。app 是 Electron 没这问题，这是网页版独有的一处适配。
function toHttps(u: string): string {
  return u.replace(/^http:\/\//, 'https://')
}

function parseCalendar(raw: unknown): CalendarWeekday[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry, idx) => {
    const e = entry as Record<string, unknown>
    const weekday = (e.weekday as Record<string, unknown>) ?? {}
    const id = typeof weekday.id === 'number' ? weekday.id : idx + 1
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
        url: toHttps(String(i.url ?? (i.id ? `https://bgm.tv/subject/${i.id}` : ''))),
        cover: toHttps(cover),
        airDate: String(i.air_date ?? ''),
        episodes: typeof i.eps === 'number' ? i.eps : 0,
        score: typeof rating.score === 'number' ? rating.score : 0,
      }
    })

    return { id, label, items }
  })
}

// serverless 没有持久磁盘 —— 进程内内存缓存（热实例复用）+ HTTP 边缘缓存（见 index.ts 的
// Cache-Control）。周期表一季度才变，14 天 TTL 够；强制刷新走 force。
const TTL_MS = 14 * 24 * 60 * 60 * 1000
let cache: { data: CalendarWeekday[]; at: number } | null = null

export interface CalendarResult {
  data: CalendarWeekday[]
  updatedAt: number
  fromCache: boolean
}

export async function getCalendar(force = false): Promise<CalendarResult> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return { data: cache.data, updatedAt: cache.at, fromCache: true }
  }
  const raw = await fetchJson(CALENDAR_URL, { headers: BGM_HEADERS, timeoutMs: 10000 })
  const data = parseCalendar(raw)
  if (data.length > 0) {
    cache = { data, at: Date.now() }
    return { data, updatedAt: cache.at, fromCache: false }
  }
  // BGM 返回空数组 —— 有旧缓存就退回旧的（不抛，是 BGM 那边的问题），否则抛
  if (cache) return { data: cache.data, updatedAt: cache.at, fromCache: true }
  throw new Error('BGM 周历为空且无缓存')
}
