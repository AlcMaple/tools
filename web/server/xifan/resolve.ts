// 稀饭在线观看解析 —— **懒加载版**（用户 2026-07-21 定）。
//
// 为什么懒加载：一次并行解析所有源 = 一串请求瞬间砸向稀饭，像爬虫、有触发反爬 / 限流的风险；
// 而且用户多半只看默认线路，预解析其余线路是白费。所以：
//   - 打开播放页 → `getPlaylist`：**一次抓取**（source 1 的页面）拿到「线路 1 地址 + 全部线路名单」。
//   - 用户点线路 2/3 → `resolveLine`：那时才抓那一条。
// 不再自动选最优线路，也不预探 content-disposition / HLS 空壳 —— 播放层「直连失败就套娃兜底」。
//
// **拷贝复用 + 换传输层**：parsePlayerData 抄自 src/main/xifan/api.ts；
// 源 tab 名单改用正则扒（web 侧只为这几个 <a> 标签不值当加 cheerio 依赖）。

import '../http' // 副作用导入：让 undici fetch 认 HTTPS_PROXY（本地 Clash 非 TUN 时用）

// 与 app 的 DESKTOP_USER_AGENT 一致 —— 稀饭对 UA 敏感。导出给 weekday.ts 复用，保证全站一个 UA。
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
export const BASE_URL = 'https://anime.xifanacg.com'
const XIFAN_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
}

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
const MAX_UPSTREAM_CONCURRENCY = 2
const MAX_UPSTREAM_WAITING = 8
const UPSTREAM_START_GAP_MS = 250
const CACHE_TTL_MS = 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 1000

export class XifanUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSec: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'XifanUpstreamError'
  }
}

export class XifanBusyError extends Error {
  readonly retryAfterSec = 2

  constructor() {
    super('稀饭解析请求较多，请稍后再试')
    this.name = 'XifanBusyError'
  }
}

interface PlayerData {
  url: string
  from: string
  id: string
  vod_data?: { vod_name?: string }
}

// ↓↓↓ parsePlayerData 逐字抄自 src/main/xifan/api.ts（勿改；要改两边一起改）↓↓↓
function parsePlayerData(html: string): PlayerData | null {
  const m1 = html.match(/var player_aaaa\s*=\s*(\{.*?\})<\/script>/)
  if (m1) {
    try { return JSON.parse(m1[1]) as PlayerData } catch { /* fall through */ }
  }
  const m2 = html.match(/var player_aaaa\s*=\s*\{(.*?)\};/s)
  if (!m2) return null
  const block = m2[1]

  function getStr(key: string): string {
    const pat = new RegExp(`\\b${key}\\s*:\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's')
    const r = block.match(pat)
    if (!r) return ''
    try { return JSON.parse(`"${r[1]}"`) } catch { return r[1].replace(/\\\//g, '/') }
  }

  const vodM = block.match(/vod_data\s*:\s*\{(.*?)\}/s)
  let vodName = ''
  if (vodM) {
    const nm = vodM[1].match(/\bvod_name\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"/s)
    if (nm) { try { vodName = JSON.parse(`"${nm[1]}"`) } catch { vodName = nm[1] } }
  }

  return { url: getStr('url'), from: getStr('from'), id: getStr('id'), vod_data: { vod_name: vodName } }
}
// ↑↑↑ 抄写结束 ↑↑↑

/**
 * 源 tab 名单 —— 从 source 1 页 HTML 里**正则**扒出（不引 cheerio）。一次抓取就拿到全部线路名，不逐条解析。
 * `vod-playerUrl` 是稀饭源切换 tab 专用 class；名字里的集数徽章 `<span class="badge">` 和图标 `<i>` 剥掉。
 * 扒不到就回空 → getPlaylist 兜底只留线路 1（不会崩，最多少了换线入口）。
 */
function parseSourceTabs(html: string): LineMeta[] {
  const out: LineMeta[] = []
  const re = /<a[^>]*class="[^"]*\bvod-playerUrl\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(html)) !== null) {
    const name = m[1]
      .replace(/<span[^>]*\bbadge\b[^>]*>[\s\S]*?<\/span>/gi, '') // 去集数徽章
      .replace(/<i[^>]*>[\s\S]*?<\/i>/gi, '') // 去图标
      .replace(/<[^>]*>/g, '') // 剥剩余标签
      .replace(/&nbsp;| /gi, ' ')
      .trim()
    out.push({ source: ++i, name: name || `线路${i}` })
  }
  return out
}

/**
 * 集数列表 —— 从 watch 页正则扒 `.anthology-list` 里的 `/watch/{animeId}/{src}/{ep}.html` 链接，按 ep 去重排序。
 * 抄自 app `parseEpLabels` 思路（换正则、只要序号）：源切换 tab（`vod-playerUrl`）也长这个 href，跳过。
 * 给播放页画「集数网格」用；扒不到 → []，播放页退化成只显示当前集（仍能靠地址栏 ep= 换集）。
 */
function parseEpList(html: string, animeId: string): number[] {
  const set = new Set<number>()
  const re = new RegExp(`<a\\b[^>]*href="/watch/${animeId}/\\d+/(\\d+)\\.html"[^>]*>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (/vod-playerUrl/i.test(m[0])) continue // 源切换 tab 不是集数
    const ep = parseInt(m[1], 10)
    if (ep > 0) set.add(ep)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * 按 URL 分类（不发额外请求）。播放层据此选 <video> / hls.js。
 *   - `.m3u8` → hls（hls.js 接管）
 *   - 其余 → mp4：`<video>` 直连，视频不经服务器。`apn.moedot.net` 最终会跳到带
 *     `content-disposition: attachment` 的 pan.wo；此前因此直接判成 iframe。真实 Chromium
 *     复测确认：播放器页使用 `Referrer-Policy: no-referrer` 后可正常作为媒体加载，所以恢复
 *     直连，拿回缓冲事件控制权；若个别浏览器仍失败，页面的 error 监听再回退官方 iframe。
 */
function classify(url: string): 'mp4' | 'hls' {
  try {
    if (new URL(url).pathname.toLowerCase().endsWith('.m3u8')) return 'hls'
  } catch { /* safeMediaUrl 会在输出前拒绝坏 URL */ }
  return 'mp4'
}

function safeMediaUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

let upstreamActive = 0
const upstreamWaiters: Array<() => void> = []
let upstreamStartQueue = Promise.resolve()
let lastUpstreamStartedAt = 0

async function acquireUpstreamSlot(): Promise<void> {
  if (upstreamActive < MAX_UPSTREAM_CONCURRENCY) {
    upstreamActive++
    return
  }
  if (upstreamWaiters.length >= MAX_UPSTREAM_WAITING) throw new XifanBusyError()
  await new Promise<void>((resolve) => upstreamWaiters.push(resolve))
}

function releaseUpstreamSlot(): void {
  const next = upstreamWaiters.shift()
  if (next) next()
  else upstreamActive--
}

function scheduleUpstreamStart(): Promise<void> {
  const gate = upstreamStartQueue.then(async () => {
    const elapsed = Date.now() - lastUpstreamStartedAt
    if (elapsed < UPSTREAM_START_GAP_MS) {
      await new Promise((resolve) => setTimeout(resolve, UPSTREAM_START_GAP_MS - elapsed))
    }
    lastUpstreamStartedAt = Date.now()
  })
  upstreamStartQueue = gate.then(() => undefined, () => undefined)
  return gate
}

async function withUpstreamSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireUpstreamSlot()
  try {
    return await fn()
  } finally {
    releaseUpstreamSlot()
  }
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null
  if (/^\d+$/.test(value)) return Number(value)
  const retryAt = Date.parse(value)
  return Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : null
}

function assertUpstreamResponse(response: Response, html: string): void {
  const cloudflareBlocked = CF_MARKERS.some((marker) => html.includes(marker))
  if (response.ok && !cloudflareBlocked) return
  const retryAfterSec = retryAfterSeconds(response.headers.get('retry-after'))
  let message = `稀饭播放页请求失败：服务器返回 HTTP ${response.status}`
  if (cloudflareBlocked) message = '稀饭被 Cloudflare 拦截，请稍后再试'
  else if (response.status === 429) {
    message = `稀饭请求过于频繁${retryAfterSec !== null ? `，请在 ${retryAfterSec} 秒后再试` : '，请稍后再试'}`
  }
  if (!response.ok) throw new XifanUpstreamError(response.status, retryAfterSec, message)
  throw new Error(message)
}

async function fetchHtml(url: string): Promise<string> {
  return withUpstreamSlot(async () => {
    const run = async (): Promise<string> => {
      await scheduleUpstreamStart()
      const res = await fetch(url, { headers: XIFAN_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(12000) })
      const html = await res.text()
      assertUpstreamResponse(res, html)
      return html
    }
    try {
      return await run()
    } catch (err) {
      // 只允许传输层瞬时抖动单次重试；HTTP 429 / 5xx 已转成 XifanUpstreamError，不会走这里。
      const msg = err instanceof Error ? err.message : String(err)
      if (!(err instanceof XifanUpstreamError) && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket disconnected|TLS|fetch failed|terminated/i.test(msg)) {
        return run()
      }
      throw err
    }
  })
}

export interface LineMeta {
  source: number
  name: string
}
export interface PlayLine {
  source: number
  url: string
  kind: 'mp4' | 'hls'
}
export interface Playlist {
  title: string
  lines: LineMeta[]
  first: PlayLine | null // 线路 1（顺手解析出来，打开即可播）
  eps: number[] // 整季集数序号（画集数网格用），扒不到就空
}

// 进程内缓存（1h）+ singleflight：同一条正在解析时所有调用复用一个 Promise，不重复打上游。
const cache = new Map<string, { v: unknown; at: number }>()
const inflight = new Map<string, Promise<unknown>>()
function cached<T>(key: string): { hit: true; v: T } | { hit: false } {
  const h = cache.get(key)
  if (h && Date.now() - h.at < CACHE_TTL_MS) {
    cache.delete(key)
    cache.set(key, h)
    return { hit: true, v: h.v as T }
  }
  if (h) cache.delete(key)
  return { hit: false }
}
function put<T>(key: string, v: T): T {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now()
    for (const [cacheKey, entry] of cache) {
      if (now - entry.at >= CACHE_TTL_MS) cache.delete(cacheKey)
    }
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined
      if (!oldest) break
      cache.delete(oldest)
    }
  }
  cache.set(key, { v, at: Date.now() })
  return v
}

function singleflight<T>(key: string, load: () => Promise<T>): Promise<T> {
  const current = inflight.get(key) as Promise<T> | undefined
  if (current) return current
  const job = load()
  inflight.set(key, job)
  const clear = (): void => {
    if (inflight.get(key) === job) inflight.delete(key)
  }
  void job.then(clear, clear)
  return job
}

/** 打开播放页调这个：一次抓 source 1 → 线路 1 地址 + 全部线路名单。**不碰线路 2/3**。 */
export async function getPlaylist(animeId: string, ep: number): Promise<Playlist> {
  const key = `pl:${animeId}:${ep}`
  const c = cached<Playlist>(key)
  if (c.hit) return c.v
  return singleflight(key, async () => {
    const latest = cached<Playlist>(key)
    if (latest.hit) return latest.v
    const body = await fetchHtml(`${BASE_URL}/watch/${animeId}/1/${ep}.html`)
    const data = parsePlayerData(body)
    const tabs = parseSourceTabs(body)
    let url1 = ''
    try { url1 = data?.url ? decodeURIComponent(data.url) : '' } catch { /* 站点返回了坏编码 */ }
    url1 = safeMediaUrl(url1)
    const first: PlayLine | null = url1 ? { source: 1, url: url1, kind: classify(url1) } : null
    const lines = tabs.length ? tabs : first ? [{ source: 1, name: '线路1' }] : []
    const eps = parseEpList(body, animeId)
    return put(key, { title: data?.vod_data?.vod_name ?? '', lines, first, eps })
  })
}

/** 用户手动点线路 N 时才调这个：只抓那一条。 */
export async function resolveLine(animeId: string, ep: number, source: number): Promise<PlayLine | null> {
  const key = `ln:${animeId}:${ep}:${source}`
  const c = cached<PlayLine | null>(key)
  if (c.hit) return c.v
  return singleflight(key, async () => {
    const latest = cached<PlayLine | null>(key)
    if (latest.hit) return latest.v
    const body = await fetchHtml(`${BASE_URL}/watch/${animeId}/${source}/${ep}.html`)
    const data = parsePlayerData(body)
    let url = ''
    try { url = data?.url ? decodeURIComponent(data.url) : '' } catch { /* 站点返回了坏编码 */ }
    url = safeMediaUrl(url)
    return put<PlayLine | null>(key, url ? { source, url, kind: classify(url) } : null)
  })
}
