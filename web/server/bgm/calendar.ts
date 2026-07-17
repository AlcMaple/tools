// 从 app 的 src/main/bgm/calendar.ts 拷来 —— 解析逻辑（parseCalendar）原样保留，只换传输层
// （Electron net → fetch）。app 那边一行不动（见 012「抓取复用策略」）。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../data-dir'
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

/**
 * 封面 URL —— 走 BGM 图床的实时缩放接口 `/r/<宽>/pic/...`（底图就是 large）。
 *
 * **宽度只认白名单 {100, 200, 400, 600, 800, 1200}，填别的一律 HTTP 400 拿到空图** ——
 * 想调清晰度只能在这几档里挑，别写 480 这种看着合理的数。
 *
 * 取 400（400×563，53KB）：卡片约 220px，视网膜 2 倍 = 440 物理像素，400 基本 1:1。
 * 之前取周历自带的 `images.common`，注释说「≈200px」其实只有 **150×211**，铺进 440 物理
 * 像素要放大 3 倍 —— 那就是封面糊的原因。而周历那套老式路径没有中间档：common 之上
 * 直接跳到 large（2081×2928、916KB），只能另走 /r/ 接口。
 */
const COVER_WIDTH = 400

function coverUrl(images: Record<string, string>): string {
  // 从 large 的路径拼 /r/<宽>/ —— large 一定是 /pic/cover/l/... 这种原图路径
  const m = (images.large ?? '').match(/^https?:\/\/[^/]+(\/pic\/.+)$/)
  if (m) return `https://lain.bgm.tv/r/${COVER_WIDTH}${m[1]}`
  // large 缺失（极少）→ 退回老式档位，糊也比没有强
  return toHttps(images.common || images.medium || images.grid || '')
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
      const rating = (i.rating as Record<string, unknown>) ?? {}
      return {
        id: typeof i.id === 'number' ? i.id : 0,
        name: String(i.name ?? ''),
        name_cn: String(i.name_cn ?? ''),
        url: toHttps(String(i.url ?? (i.id ? `https://bgm.tv/subject/${i.id}` : ''))),
        cover: coverUrl(images),
        airDate: String(i.air_date ?? ''),
        episodes: typeof i.eps === 'number' ? i.eps : 0,
        score: typeof rating.score === 'number' ? rating.score : 0,
      }
    })

    return { id, label, items }
  })
}

// 周期表一季度才变，14 天 TTL 够；强制刷新走 force。
const TTL_MS = 14 * 24 * 60 * 60 * 1000

type CacheEntry = { data: CalendarWeekday[]; at: number }
let cache: CacheEntry | null = null

// 缓存落盘 —— 内存缓存跟进程同生死，而重启是家常便饭（每次上线都得重启一次），
// 于是「14 天 TTL」实际是「14 天或到下次重启为止」，等于没有。落盘后重启也还在。
//
// 写不进去就静默退回纯内存（serverless 只读盘 / 权限不对）—— 那边本来就有 HTTP
// 边缘缓存兜底（见 index.ts 的 Cache-Control），不该为此让整个周历接口挂掉。
const CACHE_FILE = join(dataDir, 'calendar-cache.json')

function readDisk(): CacheEntry | null {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Partial<CacheEntry>
    // 校验后再用 —— 手改坏 / 写了一半的文件不能当有效缓存，否则把坏数据当好的返回
    if (!Array.isArray(raw.data) || raw.data.length === 0) return null
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null
    return { data: raw.data, at: raw.at }
  } catch {
    return null // 文件不存在 / 坏了 / 读不动 —— 当没缓存，下次 fetch 会重写
  }
}

function writeDisk(entry: CacheEntry): void {
  try {
    // 先写临时文件再 rename：直接覆盖会在崩溃 / 满盘时留下半个 JSON，
    // 之后每次启动都读到坏文件。同分区 rename 是原子的，要么旧的要么新的。
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entry))
    renameSync(tmp, CACHE_FILE)
  } catch {
    /* 落盘失败不影响功能，内存缓存照常工作 */
  }
}

export interface CalendarResult {
  data: CalendarWeekday[]
  updatedAt: number
  fromCache: boolean
}

export async function getCalendar(force = false): Promise<CalendarResult> {
  // 进程刚起来时内存是空的 —— 先看盘上有没有，有就不用打扰 BGM
  if (!cache) cache = readDisk()

  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return { data: cache.data, updatedAt: cache.at, fromCache: true }
  }
  const raw = await fetchJson(CALENDAR_URL, { headers: BGM_HEADERS, timeoutMs: 10000 })
  const data = parseCalendar(raw)
  if (data.length > 0) {
    cache = { data, at: Date.now() }
    writeDisk(cache)
    return { data, updatedAt: cache.at, fromCache: false }
  }
  // BGM 返回空数组 —— 有旧缓存就退回旧的（不抛，是 BGM 那边的问题），否则抛
  if (cache) return { data: cache.data, updatedAt: cache.at, fromCache: true }
  throw new Error('BGM 周历为空且无缓存')
}
