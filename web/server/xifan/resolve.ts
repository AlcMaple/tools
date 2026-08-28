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

import { proxyReady } from '../http' // 本地开发：等代理探测定盘，和浏览器走同一条出口
import { needsProxy } from './proxy-hosts'
import {
  assertXifanResponse,
  BASE_URL,
  DESKTOP_UA,
  XifanUpstreamError,
  xifanSessionFor,
  type XifanCookieSession,
  type XifanHttpResponse,
} from './session'

// weekday.ts 已经从这里取 UA / BASE_URL；继续转出，避免同一站点出现两份指纹常量。
export { BASE_URL, DESKTOP_UA, XifanUpstreamError } from './session'
const XIFAN_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
}

const MAX_UPSTREAM_CONCURRENCY = 2
const MAX_UPSTREAM_WAITING = 8
const UPSTREAM_START_GAP_MS = 250
const CACHE_TTL_MS = 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 1000

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

export type XifanResolveErrorCode = 'XIFAN_AUTH_REQUIRED' | 'XIFAN_ACCESS_DENIED'

export class XifanResolveError extends Error {
  constructor(
    readonly code: XifanResolveErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'XifanResolveError'
  }
}

interface AccessContext {
  uid: number | null
  session: XifanCookieSession | null
  authenticated: boolean
  scope: string
}

const sessionGenerations = new Map<number, number>()

function accessContext(uid: number | null): AccessContext {
  if (uid === null) return { uid, session: null, authenticated: false, scope: 'anon' }
  const session = xifanSessionFor(uid)
  const authenticated = session.loggedIn
  const generation = sessionGenerations.get(uid) ?? 0
  return {
    uid,
    session: authenticated ? session : null,
    authenticated,
    scope: authenticated ? `user:${uid}:${generation}` : 'anon',
  }
}

function noticeText(html: string): string {
  const content = html.match(/<div[^>]*class="[^"]*\bmsg-content\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? ''
  return content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;| /gi, ' ').replace(/\s+/g, ' ').trim()
}

function gateText(html: string): string {
  const chunks = [noticeText(html)]
  const gateClass = /class=(['"])[^'"]*(?:popedom|popeom|upgrade-gate)[^'"]*\1/gi
  let match: RegExpExecArray | null
  while ((match = gateClass.exec(html)) !== null && chunks.length < 6) {
    chunks.push(html.slice(match.index, match.index + 4000).replace(/<[^>]+>/g, ' '))
  }
  return chunks.join(' ').replace(/&nbsp;| /gi, ' ').replace(/\s+/g, ' ').trim()
}

function loggedOutPage(html: string): boolean {
  const notice = noticeText(html)
  return notice.includes('亲爱的：未登录')
    || html.includes('class="mac_login_form')
    || html.includes('<h1>账号登录</h1>')
    || /请先登录|登录后(?:才可|方可|观看)/.test(notice)
}

function deniedPage(html: string): boolean {
  return /亲爱的：您没有权限访问此数据|没有权限观看/.test(html)
    || /没有权限访问|权限不足|升级会员|请先购买|积分不足|需要购买|付费后/.test(gateText(html))
}

function accessError(access: AccessContext): XifanResolveError {
  return access.authenticated
    ? new XifanResolveError('XIFAN_ACCESS_DENIED', '当前稀饭账号没有该资源的观看权限')
    : new XifanResolveError('XIFAN_AUTH_REQUIRED', '该资源需要先登录稀饭账号')
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

async function fetchAnonymous(url: string): Promise<XifanHttpResponse> {
  await proxyReady
  const run = async (): Promise<XifanHttpResponse> => {
    await scheduleUpstreamStart()
    const response = await fetch(url, {
      headers: XIFAN_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    })
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer()),
      url: response.url,
    }
  }
  try {
    return await run()
  } catch (error) {
    // 只允许 GET 的传输层瞬时抖动单次重试；HTTP 429 / 5xx 不在这里重试。
    const message = error instanceof Error ? error.message : String(error)
    if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket disconnected|TLS|fetch failed|terminated/i.test(message)) {
      return run()
    }
    throw error
  }
}

async function fetchHtml(url: string, access: AccessContext): Promise<string> {
  return withUpstreamSlot(async () => {
    const response = access.session
      ? await access.session.get(url, {}, { retryTransient: true, timeoutMs: 12000 })
      : await fetchAnonymous(url)
    const html = assertXifanResponse(response, '稀饭播放页请求')
    if (loggedOutPage(html)) {
      access.session?.clear()
      if (access.uid !== null) clearXifanResolveCache(access.uid)
      throw new XifanResolveError('XIFAN_AUTH_REQUIRED', '该资源需要先登录稀饭账号')
    }
    if (deniedPage(html)) throw accessError(access)
    return html
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
  /**
   * `player_aaaa.from` —— 源站用它在 `/static/js/playerconfig.js` 的 `MacPlayerConfig.player_list`
   * 里查这条线路该用哪个官方播放器地址（xfy2/AL/CS → `code=xfdm1&from=cf`，xfxf1 → `code=xfdm2`）。
   * 直连播放用不到它，只有回退官方 iframe 时要照着拼，拼错就是一个永远转圈的空播放器。
   */
  from: string
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

/** 登录、退出或远端失效后轮换代次；旧请求即使稍后完成，也不会被新会话命中。 */
export function clearXifanResolveCache(uid: number): void {
  sessionGenerations.set(uid, (sessionGenerations.get(uid) ?? 0) + 1)
  const prefix = `user:${uid}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key)
  }
}

/**
 * 打开播放页调这个：抓 source 1 → 拿到线路 1 地址 + 全部线路名单 + 集数。
 *
 * **默认线路的选法：按域名挑「不需要代理的」，不是按线路编号。** 线路号和源站没有
 * 固定对应关系（实测 3498 的线路一就是 play.xfvod.pro 快源，3535 的线路一才是
 * apn.moedot.net 慢源）。所以只有当 source 1 恰好是慢源时，才多花一次请求去看看
 * 下一条是不是直连快源——直连不占服务器那 6Mbps 出口，能不占就别占。
 *
 * source 1 本来就是快源时**不多打任何请求**，懒加载的原意保持不变。
 */
export async function getPlaylist(animeId: string, ep: number, uid: number | null = null): Promise<Playlist> {
  const access = accessContext(uid)
  const key = `${access.scope}:pl:${animeId}:${ep}`
  const c = cached<Playlist>(key)
  if (c.hit) return c.v
  return singleflight(key, async () => {
    const latest = cached<Playlist>(key)
    if (latest.hit) return latest.v
    const body = await fetchHtml(`${BASE_URL}/watch/${animeId}/1/${ep}.html`, access)
    const data = parsePlayerData(body)
    const tabs = parseSourceTabs(body)
    let url1 = ''
    try { url1 = data?.url ? decodeURIComponent(data.url) : '' } catch { /* 站点返回了坏编码 */ }
    url1 = safeMediaUrl(url1)
    const line1: PlayLine | null = url1
      ? { source: 1, url: url1, kind: classify(url1), from: data?.from ?? '' }
      : null
    const lines = tabs.length ? tabs : line1 ? [{ source: 1, name: '线路1' }] : []
    const eps = parseEpList(body, animeId)

    // 只有「线路 1 是慢源 且 还有别的线路」时才多试一条。失败/也是慢源就老实用线路 1。
    let first = line1
    if (line1 && needsProxy(line1.url) && lines.length > 1) {
      const next = lines.find((l) => l.source !== 1)
      if (next) {
        try {
          const alt = await resolveLine(animeId, ep, next.source, uid)
          if (alt && !needsProxy(alt.url)) first = alt
        } catch {
          /* 备选线路解析不出来不影响主流程，继续用线路 1 */
        }
      }
    }
    return put(key, { title: data?.vod_data?.vod_name ?? '', lines, first, eps })
  })
}

/** 用户手动点线路 N 时才调这个：只抓那一条。 */
export async function resolveLine(
  animeId: string,
  ep: number,
  source: number,
  uid: number | null = null,
): Promise<PlayLine | null> {
  const access = accessContext(uid)
  const key = `${access.scope}:ln:${animeId}:${ep}:${source}`
  const c = cached<PlayLine | null>(key)
  if (c.hit) return c.v
  return singleflight(key, async () => {
    const latest = cached<PlayLine | null>(key)
    if (latest.hit) return latest.v
    const body = await fetchHtml(`${BASE_URL}/watch/${animeId}/${source}/${ep}.html`, access)
    const data = parsePlayerData(body)
    let url = ''
    try { url = data?.url ? decodeURIComponent(data.url) : '' } catch { /* 站点返回了坏编码 */ }
    url = safeMediaUrl(url)
    return put<PlayLine | null>(key, url ? { source, url, kind: classify(url), from: data?.from ?? '' } : null)
  })
}
