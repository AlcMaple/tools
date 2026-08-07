// Girigiri 搜索 —— 搜索页有站点验证码，验证码图片、校验、搜索必须共用同一个 cookie 罐。
//
// 网页版是多用户服务，按 MapleTools 用户隔离短时会话；不会把 A 用户的验证码 cookie
// 交给 B 用户。播放页不依赖这个会话，仍走 resolve.ts 的匿名浏览器直连路径。
import * as cheerio from 'cheerio/slim'
import '../http'
import { crawlAllPages } from '../shared/maccms-search-paginator'
import { BASE_URL, GIRIGIRI_UA } from './resolve'

const BASE_ORIGIN = new URL(BASE_URL).origin
const BASE_HEADERS: Record<string, string> = {
  'User-Agent': GIRIGIRI_UA,
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
const SESSION_TTL_MS = 15 * 60 * 1000
const MAX_PAGES = 20
export const GIRIGIRI_SEARCH_MAX_LENGTH = 100

export interface GirigiriSearchHit {
  girigiriId: string
  girigiriName: string
  cover: string
  episode: string
  year: string
  area: string
}

export type GirigiriSearchResponse =
  | { needsCaptcha: true }
  | { needsCaptcha: false; data: GirigiriSearchHit[] }

export interface GirigiriCaptcha {
  imageB64: string
  mime: string
}

interface HttpResponse {
  status: number
  headers: Headers
  body: Buffer
}

// 搜索是用户主动触发的低频操作；共享出口 IP 时仍把请求起始时刻错开。
let requestQueue = Promise.resolve()
let lastStartedAt = 0
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function scheduleRequest<T>(fn: () => Promise<T>): Promise<T> {
  const job = requestQueue.then(async () => {
    const targetGap = 1000 + Math.floor(Math.random() * 301)
    const elapsed = Date.now() - lastStartedAt
    if (elapsed < targetGap) await sleep(targetGap - elapsed)
    lastStartedAt = Date.now()
    return fn()
  })
  requestQueue = job.then(() => undefined, () => undefined)
  return job
}

function setCookieHeaders(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] }
  const values = h.getSetCookie?.() ?? []
  if (values.length > 0) return values
  const one = headers.get('set-cookie')
  return one ? [one] : []
}

class GirigiriCookieSession {
  private readonly cookies = new Map<string, string>()
  private lastUsedAt = Date.now()

  get idleSince(): number {
    return this.lastUsedAt
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private ingest(headers: Headers): void {
    for (const raw of setCookieHeaders(headers)) {
      const pair = raw.split(';', 1)[0].trim()
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(raw)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  async get(url: string, extraHeaders: Record<string, string> = {}): Promise<HttpResponse> {
    this.lastUsedAt = Date.now()
    let current = url
    for (let redirectsLeft = 5; ; redirectsLeft--) {
      const response = await scheduleRequest(() => fetch(current, {
        headers: { ...BASE_HEADERS, Cookie: this.cookieHeader(), ...extraHeaders },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      }))
      this.ingest(response.headers)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (location) {
          if (redirectsLeft <= 0) throw new Error('Girigiri 重定向次数过多')
          const next = new URL(location, current)
          if (next.origin !== BASE_ORIGIN) throw new Error('Girigiri 返回了不安全的跨站重定向')
          current = next.href
          continue
        }
      }
      return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) }
    }
  }
}

const sessions = new Map<number, GirigiriCookieSession>()

function sessionFor(uid: number): GirigiriCookieSession {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.idleSince > SESSION_TTL_MS) sessions.delete(id)
  }
  let session = sessions.get(uid)
  if (!session) {
    session = new GirigiriCookieSession()
    sessions.set(uid, session)
  }
  return session
}

function assertHtml(response: HttpResponse, action: string): string {
  const html = response.body.toString('utf8')
  if (CF_MARKERS.some((marker) => html.includes(marker))) throw new Error('Girigiri 被 Cloudflare 拦截，请稍后再试')
  if (response.status < 200 || response.status >= 300) throw new Error(`${action}失败：服务器返回 HTTP ${response.status}`)
  return html
}

function needsCaptcha(html: string): boolean {
  return html.includes('name="verify"') || html.includes('ds-verify-img') || html.includes('verify/index.html')
}

function absoluteUrl(href: string): string {
  if (!href) return ''
  try {
    const url = new URL(href, BASE_URL)
    return url.origin === BASE_ORIGIN ? url.href : ''
  } catch {
    return ''
  }
}

function girigiriIdFromUrl(url: string): string {
  const match = url.match(/\/(GV\d+)(?:[/?-]|$)/i) ?? url.match(/\/play(GV\d+)-/i)
  return match?.[1]?.toUpperCase() ?? ''
}

function parseSearchPage(html: string): GirigiriSearchHit[] {
  const $ = cheerio.load(html)
  const out: GirigiriSearchHit[] = []
  const seen = new Set<string>()
  let items = $('div[class*="vod-item"][class*="col"], div[class^="g-movie-item"], li[class*="vod-list-item"]')
  if (!items.length) items = $('div[class*="mask2"] > div[class*="vod-detail"]')

  for (const el of items.toArray()) {
    const link = $(el).find('a[href]').first()
    if (!link.length) continue
    const href = absoluteUrl(link.attr('href') ?? '')
    const id = girigiriIdFromUrl(href)
    if (!id || seen.has(id)) continue
    const titleTag = link.find('h3').first()
    const title = (titleTag.length ? titleTag.text() : link.find('span').first().text() || link.text()).trim()
    if (!title) continue
    seen.add(id)
    const img = $(el).find('img').first()
    const rawCover = img.attr('data-src') ?? img.attr('data-original') ?? img.attr('src') ?? ''
    const meta = $(el).find('div[class*="info"], span[class*="desc"], div[class*="meta"], p[class*="detail"]').text()
    out.push({
      girigiriId: id,
      girigiriName: title,
      cover: absoluteUrl(rawCover),
      episode: meta.match(/更新至[^\s·]+|全集|完结|先行[^\s·]*/)?.[0] ?? '',
      year: meta.match(/\d{4}/)?.[0] ?? '',
      area: meta.match(/日本|中国|美国|韩国|国产|日漫|大陆/)?.[0] ?? '',
    })
  }

  // 模板改版时至少保留 /GV…/ 结果，不把页面误报成空结果。
  if (!out.length) {
    $('a[href]').each((_, el) => {
      const href = absoluteUrl($(el).attr('href') ?? '')
      const id = girigiriIdFromUrl(href)
      const title = $(el).text().trim()
      if (id && title && !seen.has(id)) {
        seen.add(id)
        out.push({ girigiriId: id, girigiriName: title, cover: '', episode: '', year: '', area: '' })
      }
    })
  }
  return out
}

function uniqueHits(hits: GirigiriSearchHit[]): GirigiriSearchHit[] {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    if (seen.has(hit.girigiriId)) return false
    seen.add(hit.girigiriId)
    return true
  })
}

export async function getGirigiriCaptcha(uid: number): Promise<GirigiriCaptcha> {
  const response = await sessionFor(uid).get(`${BASE_URL}/verify/index.html?t=${Date.now()}`)
  if (response.status < 200 || response.status >= 300) throw new Error(`Girigiri 验证码请求失败：服务器返回 HTTP ${response.status}`)
  const mime = response.headers.get('content-type')?.split(';', 1)[0] ?? ''
  // 验证码只接受常见栅格格式，不把 SVG 等可执行矢量内容交给前端 data URL。
  if (!/^image\/(?:png|jpe?g|gif|webp)$/i.test(mime)) {
    if (CF_MARKERS.some((marker) => response.body.toString('utf8').includes(marker))) throw new Error('Girigiri 被 Cloudflare 拦截，请稍后再试')
    throw new Error('Girigiri 验证码返回了非图片内容')
  }
  return { imageB64: response.body.toString('base64'), mime }
}

export async function verifyGirigiriCaptcha(uid: number, code: string): Promise<{ success: boolean }> {
  const response = await sessionFor(uid).get(
    `${BASE_URL}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`,
    { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' },
  )
  const body = response.body.toString('utf8')
  if (response.status < 200 || response.status >= 300) throw new Error(`Girigiri 验证码校验失败：服务器返回 HTTP ${response.status}`)
  try {
    const data = JSON.parse(body) as { code?: unknown; msg?: unknown }
    return { success: Number(data.code) === 1 || data.msg === '成功' || String(data.msg ?? '').toLowerCase() === 'ok' }
  } catch {
    return { success: body.includes('成功') || body.toLowerCase().includes('"msg":"ok"') }
  }
}

export async function searchGirigiri(uid: number, keyword: string): Promise<GirigiriSearchResponse> {
  const clean = keyword.trim()
  if (!clean || clean.length > GIRIGIRI_SEARCH_MAX_LENGTH) {
    throw new Error(`搜索词长度需为 1–${GIRIGIRI_SEARCH_MAX_LENGTH} 个字符`)
  }
  const session = sessionFor(uid)
  const first = await session.get(`${BASE_URL}/search/-------------/?wd=${encodeURIComponent(clean)}`)
  const firstHtml = assertHtml(first, 'Girigiri 搜索')
  if (needsCaptcha(firstHtml)) return { needsCaptcha: true }

  const all = await crawlAllPages({
    firstHtml,
    baseUrl: BASE_URL,
    parsePage: parseSearchPage,
    fetchHtml: async (pageUrl) => {
      const html = assertHtml(await session.get(pageUrl), 'Girigiri 搜索')
      if (needsCaptcha(html)) throw new Error('Girigiri 搜索验证码已过期，请重新获取')
      return html
    },
    maxPages: MAX_PAGES,
  })
  return { needsCaptcha: false, data: uniqueHits(all) }
}
