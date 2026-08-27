// Girigiri 在线观看解析。
//
// 官方页面是 MacCMS：/GV{id}/ 是番剧详情，/playGV{id}-{source}-{ep}/ 是某片源某集的播放页。
// 播放地址写在 player_aaaa 里，encrypt=2 时是「base64 → percent decode」；地址本身是 CDN 的
// 静态 m3u8 / mp4，浏览器直接拉，不让网页服务器中转视频字节。
//
// 和网页版稀饭保持同一个用户体验边界：打开先抓第 1 条线路，线路列表和集数一起拿到；其余线路
// 只有用户点选时才请求，避免一次打开就向站点发一串无用请求。
import { proxyReady } from '../http'

export const BASE_URL = 'https://ani.girigirilove.com'
const BASE_ORIGIN = new URL(BASE_URL).origin
const GIRIGIRI_ID_RE = /^GV\d+$/i
export const GIRIGIRI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HEADERS: Record<string, string> = {
  'User-Agent': GIRIGIRI_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
}

const DATA_FORM_MAP: Record<string, string> = { cht: '繁中', chs: '简中' }
const CF_MARKERS = [
  'Just a moment',
  'cf-browser-verification',
  'challenge-platform',
  '/cdn-cgi/challenge-platform',
  'Attention Required! | Cloudflare',
  'cf-error-details',
  'Error 1020',
  'Enable JavaScript and cookies to continue',
]

interface PlayerData {
  url?: string
  encrypt?: number
  vod_data?: { vod_name?: string }
}

export interface GirigiriLineMeta {
  source: number
  name: string
}

export interface GirigiriPlayLine {
  source: number
  url: string
  kind: 'mp4' | 'hls'
}

export interface GirigiriPlaylist {
  title: string
  lines: GirigiriLineMeta[]
  first: GirigiriPlayLine | null
  eps: number[]
}

export interface GirigiriSearchPageItem {
  id: string
  name: string
}

export function isGirigiriId(value: string): boolean {
  return GIRIGIRI_ID_RE.test(value)
}

function pageUrl(id: string, source: number, ep: number): string {
  return `${BASE_URL}/play${id}-${source}-${ep}/`
}

function classify(url: string): 'mp4' | 'hls' {
  return /\.m3u8(?:$|[?#])/i.test(url) ? 'hls' : 'mp4'
}

function parsePlayerObject(html: string): PlayerData | null {
  const marker = html.indexOf('player_aaaa')
  if (marker < 0) return null
  const start = html.indexOf('{', marker)
  if (start < 0) return null

  // 不能用懒惰正则截 JSON：vod_data 等字段的文本可能带花括号。按字符串状态做括号配平。
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      end = i
      break
    }
  }
  if (end < 0) return null
  try {
    return JSON.parse(html.slice(start, end + 1)) as PlayerData
  } catch {
    return null
  }
}

function decodePlayerUrl(data: PlayerData | null): string {
  const raw = data?.url ?? ''
  if (!raw) return ''
  try {
    const decoded = data?.encrypt === 2
      ? decodeURIComponent(Buffer.from(raw, 'base64').toString('utf8'))
      : data?.encrypt === 1
        ? decodeURIComponent(raw)
        : raw
    try {
      const url = new URL(decoded)
      return url.protocol === 'https:' ? url.href : ''
    } catch {
      return ''
    }
  } catch {
    return ''
  }
}

/** 片源 tab 是服务端 HTML，data-form 的 cht/chs 与 source 序号一一对应。 */
function parseSourceTabs(html: string): GirigiriLineMeta[] {
  const out: GirigiriLineMeta[] = []
  const re = /<a\b([^>]*\bvod-playerUrl\b[^>]*)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1]
    const body = match[2]
    const form = attrs.match(/\bdata-form\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() ?? ''
    const name = body
      .replace(/<span[^>]*\bbadge\b[^>]*>[\s\S]*?<\/span>/gi, '')
      .replace(/<i[^>]*>[\s\S]*?<\/i>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;| /gi, ' ')
      .trim()
    const source = out.length + 1
    out.push({ source, name: DATA_FORM_MAP[form] || name || `线路${source}` })
  }
  return out
}

/** 从 anthology-list 中抠出整季集数；同一集的繁中/简中只保留一个数字。 */
function parseEpisodes(html: string, id: string): number[] {
  const out = new Set<number>()
  const re = /href\s*=\s*(["'])\/play(GV\d+)-(\d+)-(\d+)\/\1/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    if (match[2].toUpperCase() !== id.toUpperCase()) continue
    const ep = Number(match[4])
    if (Number.isInteger(ep) && ep > 0) out.add(ep)
  }
  return [...out].sort((a, b) => a - b)
}

async function fetchHtml(url: string): Promise<string> {
  await proxyReady // 本地开发：等代理探测定盘，和浏览器走同一条出口
  const run = async (): Promise<string> => {
    const response = await fetch(url, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    })
    const finalOrigin = new URL(response.url).origin
    if (finalOrigin !== BASE_ORIGIN) throw new Error('Girigiri 返回了不安全的跨站重定向')
    const body = await response.text()
    if (CF_MARKERS.some((marker) => body.includes(marker))) throw new Error('Girigiri 被 Cloudflare 拦截，请稍后再试')
    if (!response.ok) throw new Error(`Girigiri 播放页请求失败：服务器返回 HTTP ${response.status}`)
    return body
  }

  try {
    return await run()
  } catch (err) {
    // 仅允许传输层瞬时抖动单次重试；HTTP 错误和站点限流直接交给 UI。
    const message = err instanceof Error ? err.message : String(err)
    if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket disconnected|TLS|fetch failed|terminated/i.test(message)) return run()
    throw err
  }
}

const cache = new Map<string, { value: unknown; at: number }>()
const CACHE_TTL = 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 5000

function cached<T>(key: string): T | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at >= CACHE_TTL) {
    cache.delete(key)
    return undefined
  }
  return hit.value as T
}

function put<T>(key: string, value: T): T {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now()
    for (const [cacheKey, hit] of cache) {
      if (now - hit.at >= CACHE_TTL) cache.delete(cacheKey)
    }
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest) cache.delete(oldest)
    }
  }
  cache.set(key, { value, at: Date.now() })
  return value
}

function assertArgs(id: string, ep: number): void {
  if (!isGirigiriId(id)) throw new Error('girigiriId 不合法')
  if (!Number.isInteger(ep) || ep < 1) throw new Error('ep 不合法')
}

/** 打开播放页：抓 source 1 的一集，同时拿到标题、线路名单和集数网格。 */
export async function getPlaylist(id: string, ep: number): Promise<GirigiriPlaylist> {
  assertArgs(id, ep)
  const key = `pl:${id.toUpperCase()}:${ep}`
  const hit = cached<GirigiriPlaylist>(key)
  if (hit) return hit
  const body = await fetchHtml(pageUrl(id, 1, ep))
  const data = parsePlayerObject(body)
  const url = decodePlayerUrl(data)
  const first = url ? { source: 1, url, kind: classify(url) } : null
  const tabs = parseSourceTabs(body)
  const lines = tabs.length ? tabs : first ? [{ source: 1, name: '线路1' }] : []
  return put(key, {
    title: data?.vod_data?.vod_name?.trim() ?? '',
    lines,
    first,
    eps: parseEpisodes(body, id),
  })
}

/** 用户点选线路 N 时才抓取对应播放页。 */
export async function resolveLine(id: string, ep: number, source: number): Promise<GirigiriPlayLine | null> {
  assertArgs(id, ep)
  if (!Number.isInteger(source) || source < 1) throw new Error('source 不合法')
  const key = `ln:${id.toUpperCase()}:${ep}:${source}`
  const hit = cached<GirigiriPlayLine | null>(key)
  if (hit !== undefined) return hit
  const data = parsePlayerObject(await fetchHtml(pageUrl(id, source, ep)))
  const url = decodePlayerUrl(data)
  return put(key, url ? { source, url, kind: classify(url) } : null)
}
