// 稀饭在线观看解析 —— **懒加载版**（用户 2026-07-21 定）。
//
// 为什么懒加载：一次并行解析所有源 = 一串请求瞬间砸向稀饭，像爬虫、有触发反爬 / 限流的风险；
// 而且用户多半只看默认线路，预解析其余线路是白费。所以：
//   - 打开播放页 → `getPlaylist`：**一次抓取**（source 1 的页面）拿到「线路 1 地址 + 全部线路名单」。
//   - 用户点线路 2/3 → `resolveLine`：那时才抓那一条。
// 不再自动选最优线路，也不预探 content-disposition / HLS 空壳 —— 播放层「直连失败就套娃兜底」。
//
// **拷贝复用 + 换传输层**（ideas/012）：parsePlayerData 抄自 src/main/xifan/api.ts；
// 源 tab 名单改用正则扒（web 侧只为这几个 <a> 标签不值当加 cheerio 依赖）。

import '../http' // 副作用导入：让 undici fetch 认 HTTPS_PROXY（本地 Clash 非 TUN 时用）
import {
  assertXifanHtml,
  BASE_URL,
  DESKTOP_UA,
  xifanSessionFor,
  type XifanCookieSession,
  type XifanHttpResponse,
} from './session'

export { BASE_URL, DESKTOP_UA } from './session'

const XIFAN_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
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

  return {
    url: getStr('url'),
    from: getStr('from'),
    id: getStr('id'),
    vod_data: { vod_name: vodName },
  }
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
 * 按 URL 分类（不发额外请求）。播放层据此选 <video> / hls.js / 直接套娃。
 *   - `.m3u8` → hls（hls.js 接管）
 *   - **下载型链接** → iframe：`<video>` 喂它只会被浏览器当**附件下载**（触发下载器、还播不了），
 *     白等一轮直连失败才切套娃。`apn.moedot.net/d/…` 是联通网盘代理，302 跳 `pan.wo.cn/openapi/download`
 *     —— 这是**服务端行为、各端一致**（非 011 那种 localhost 专属），所以直接判死、跳过 <video>。
 *   - 其余（xfvod 等干净直链）→ mp4：`<video>` 直连，视频不经服务器（零带宽，最优路径，别误伤）。
 */
function classify(url: string): 'mp4' | 'hls' | 'iframe' {
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls'
  if (/apn\.moedot\.net|pan\.wo\.cn|\/openapi\/download/i.test(url)) return 'iframe'
  return 'mp4'
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

function accessContext(uid: number | null): AccessContext {
  if (uid === null) return { uid, session: null, authenticated: false, scope: 'anon' }
  const session = xifanSessionFor(uid)
  const authenticated = session.loggedIn
  return {
    uid,
    session: authenticated ? session : null,
    authenticated,
    scope: authenticated ? `user:${uid}` : 'anon',
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

async function fetchAnonymous(url: string): Promise<XifanHttpResponse> {
  const run = async (): Promise<XifanHttpResponse> => {
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
  } catch (err) {
    // 传输层瞬时抖动（TLS socket 断、ECONNRESET、DNS 抖）允许**单次**重试 —— AI_GUIDELINES 唯一放行的
    // 代码层重试。应用层失败（4xx/5xx）不在此列。稀饭偶发 "socket disconnected before TLS"，重试即好。
    const msg = err instanceof Error ? err.message : String(err)
    if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket disconnected|TLS|fetch failed|terminated/i.test(msg)) return run()
    throw err
  }
}

async function fetchHtml(url: string, access: AccessContext): Promise<string> {
  const response = access.session
    ? await access.session.get(url, {}, { retryTransient: true, timeoutMs: 12000 })
    : await fetchAnonymous(url)
  const html = assertXifanHtml(response, '稀饭播放页请求')

  if (loggedOutPage(html)) {
    access.session?.clear()
    if (access.uid !== null) clearXifanResolveCache(access.uid)
    throw new XifanResolveError('XIFAN_AUTH_REQUIRED', '该资源需要先登录稀饭账号')
  }
  if (deniedPage(html)) throw accessError(access)
  return html
}

export interface LineMeta {
  source: number
  name: string
}
export interface PlayLine {
  source: number
  url: string
  kind: 'mp4' | 'hls' | 'iframe' // iframe = 下载型链接，直接套娃（见 classify）
}
export interface Playlist {
  title: string
  lines: LineMeta[]
  first: PlayLine | null // 线路 1（顺手解析出来，打开即可播）
  eps: number[] // 整季集数序号（画集数网格用），扒不到就空
}

// 进程内缓存（1h）—— 匿名结果共享；登录结果按 MapleTools 用户隔离，受限地址不会串账号。
// **不预解析、不并行**：缓存的只是「已经解析过的那条」。
const cache = new Map<string, { v: unknown; at: number }>()
const TTL = 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 5000
function cached<T>(key: string): { hit: true; v: T } | { hit: false } {
  const h = cache.get(key)
  if (h && Date.now() - h.at < TTL) return { hit: true, v: h.v as T }
  if (h) cache.delete(key)
  return { hit: false }
}
function put<T>(key: string, v: T): T {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now()
    for (const [cacheKey, entry] of cache) {
      if (now - entry.at >= TTL) cache.delete(cacheKey)
    }
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest) cache.delete(oldest)
    }
  }
  cache.set(key, { v, at: Date.now() })
  return v
}

export function clearXifanResolveCache(uid: number): void {
  const prefix = `user:${uid}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/** 打开播放页调这个：一次抓 source 1 → 线路 1 地址 + 全部线路名单。**不碰线路 2/3**。 */
export async function getPlaylist(animeId: string, ep: number, uid: number | null = null): Promise<Playlist> {
  const access = accessContext(uid)
  const key = `${access.scope}:pl:${animeId}:${ep}`
  const c = cached<Playlist>(key)
  if (c.hit) return c.v
  const body = await fetchHtml(`${BASE_URL}/watch/${animeId}/1/${ep}.html`, access)
  const data = parsePlayerData(body)
  const tabs = parseSourceTabs(body)
  const url1 = data?.url ? decodeURIComponent(data.url) : ''
  const first: PlayLine | null = url1 ? { source: 1, url: url1, kind: classify(url1) } : null
  const lines = tabs.length ? tabs : first ? [{ source: 1, name: '线路1' }] : []
  const eps = parseEpList(body, animeId)
  return put(key, { title: data?.vod_data?.vod_name ?? '', lines, first, eps })
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
  const body = await fetchHtml(`${BASE_URL}/watch/${animeId}/${source}/${ep}.html`, access)
  const data = parsePlayerData(body)
  const url = data?.url ? decodeURIComponent(data.url) : ''
  return put<PlayLine | null>(key, url ? { source, url, kind: classify(url) } : null)
}
