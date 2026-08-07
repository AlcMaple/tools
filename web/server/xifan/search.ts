// 稀饭全站搜索 —— 搜索页有验证码，验证码图片、校验、搜索必须共用同一个 cookie 罐。
//
// 桌面端是一台机器一个 HttpSession；网页版是多用户服务，所以这里按登录用户
// 建短时内存会话，避免 A 用户的验证码 cookie 被 B 用户拿去提交。视频播放仍走
// resolve.ts 的浏览器直连路径，搜索只负责把稀饭 animeId 找出来。
import * as cheerio from 'cheerio/slim'
import '../http'
import { BASE_URL, DESKTOP_UA } from './resolve'

const BASE_HEADERS: Record<string, string> = {
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

const SESSION_TTL_MS = 15 * 60 * 1000
const MAX_PAGES = 20
export const XIFAN_SEARCH_MAX_LENGTH = 100
const BASE_ORIGIN = new URL(BASE_URL).origin

export interface XifanSearchHit {
  xifanId: number
  xifanName: string
  cover: string
  episode: string
  year: string
  area: string
}

export type XifanSearchResponse =
  | { needsCaptcha: true }
  | { needsCaptcha: false; data: XifanSearchHit[] }

export interface XifanCaptcha {
  imageB64: string
  mime: string
}

interface HttpResponse {
  status: number
  headers: Headers
  body: Buffer
}

// 稀饭搜索是用户主动触发的低频操作，但多个用户共用一个出口 IP，仍要把请求
// 起始时间错开；验证码失败不在这里自动重试，交给用户刷新 / 再提交。
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

class XifanCookieSession {
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

  private async fetchOnce(url: string, headers: Record<string, string>): Promise<Response> {
    return fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
  }

  async get(url: string, extraHeaders: Record<string, string> = {}): Promise<HttpResponse> {
    this.lastUsedAt = Date.now()
    let current = url
    for (let redirectsLeft = 5; ; redirectsLeft--) {
      const response = await scheduleRequest(() => this.fetchOnce(current, {
        ...BASE_HEADERS,
        Cookie: this.cookieHeader(),
        ...extraHeaders,
      }))
      this.ingest(response.headers)

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (location) {
          if (redirectsLeft <= 0) throw new Error('稀饭重定向次数过多')
          const next = new URL(location, current)
          if (next.origin !== BASE_ORIGIN) throw new Error('稀饭返回了不安全的跨站重定向')
          current = next.href
          continue
        }
      }

      return {
        status: response.status,
        headers: response.headers,
        body: Buffer.from(await response.arrayBuffer()),
      }
    }
  }
}

const sessions = new Map<number, XifanCookieSession>()

function sessionFor(uid: number): XifanCookieSession {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.idleSince > SESSION_TTL_MS) sessions.delete(id)
  }
  let session = sessions.get(uid)
  if (!session) {
    session = new XifanCookieSession()
    sessions.set(uid, session)
  }
  return session
}

function assertHtml(response: HttpResponse): string {
  const html = response.body.toString('utf8')
  if (CF_MARKERS.some((marker) => html.includes(marker))) {
    throw new Error('稀饭被 Cloudflare 拦截，请稍后再试')
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`稀饭搜索失败：服务器返回 HTTP ${response.status}`)
  }
  return html
}

function needsCaptcha(html: string): boolean {
  return html.includes('name="verify"') || html.includes('ds-verify-img')
}

function absoluteUrl(href: string): string {
  if (!href) return ''
  try {
    return new URL(href, BASE_URL).href
  } catch {
    return ''
  }
}

function subjectIdFromUrl(url: string): number {
  const match = url.match(/\/(?:watch|vodplay)\/(\d+)(?:[\/.?-]|$)/)
    ?? url.match(/\/(?:voddetail|detail)\/(\d+)(?:[\/.?-]|$)/)
  return match ? Number(match[1]) : 0
}

function parseSearchPage(html: string): XifanSearchHit[] {
  const $ = cheerio.load(html)
  const out: XifanSearchHit[] = []

  $('div.row.mask2 div.vod-detail.search-list').each((_, el) => {
    const titleTag = $(el).find('h3.slide-info-title').first()
    const title = titleTag.text().trim()
    if (!title) return

    const detailHref = titleTag.parent('a').attr('href') ?? ''
    const watchHref = $(el).find('div.vod-detail-bnt a.button').attr('href') ?? ''
    const watchUrl = absoluteUrl(watchHref)
    const detailUrl = absoluteUrl(detailHref)
    const xifanId = subjectIdFromUrl(watchUrl) || subjectIdFromUrl(detailUrl)
    if (!xifanId) return

    const remarks: string[] = []
    $(el).find('span.slide-info-remarks').each((__, remark) => {
      remarks.push($(remark).text().trim())
    })
    const rawCover = $(el).find('div.detail-pic img').first().attr('data-src')
      ?? $(el).find('div.detail-pic img').first().attr('src')
      ?? ''

    out.push({
      xifanId,
      xifanName: title,
      cover: absoluteUrl(rawCover),
      episode: remarks[0] ?? '',
      year: remarks[1] ?? '',
      area: remarks[2] ?? '',
    })
  })

  return out
}

function nextPageUrl(html: string): string | null {
  const $ = cheerio.load(html)
  const href = $('a.page-link[title="下一页"]').attr('href') ?? ''
  if (!href || href === 'javascript:') return null
  const next = absoluteUrl(href)
  return next || null
}

function uniqueHits(hits: XifanSearchHit[]): XifanSearchHit[] {
  const seen = new Set<number>()
  return hits.filter((hit) => {
    if (seen.has(hit.xifanId)) return false
    seen.add(hit.xifanId)
    return true
  })
}

export async function getXifanCaptcha(uid: number): Promise<XifanCaptcha> {
  const response = await sessionFor(uid).get(`${BASE_URL}/verify/index.html?t=${Date.now()}`)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`稀饭验证码请求失败：服务器返回 HTTP ${response.status}`)
  }
  const rawType = response.headers.get('content-type')?.split(';', 1)[0] || ''
  // SVG / HTML 不能作为验证码回传：即便前端放进 <img>，也不把可执行矢量内容
  // 当作跨边界数据交给浏览器。
  if (!/^image\/(?:png|jpe?g|gif|webp)$/i.test(rawType)) {
    const body = response.body.toString('utf8')
    if (CF_MARKERS.some((marker) => body.includes(marker))) {
      throw new Error('稀饭被 Cloudflare 拦截，请稍后再试')
    }
    throw new Error('稀饭验证码返回了非图片内容')
  }
  return { imageB64: response.body.toString('base64'), mime: rawType }
}

export async function verifyXifanCaptcha(uid: number, code: string): Promise<{ success: boolean }> {
  const response = await sessionFor(uid).get(
    `${BASE_URL}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`,
    {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  )
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`稀饭验证码校验失败：服务器返回 HTTP ${response.status}`)
  }
  const body = response.body.toString('utf8')
  try {
    const data = JSON.parse(body) as { code?: unknown; msg?: unknown }
    return {
      success: Number(data.code) === 1
        || data.msg === '成功'
        || String(data.msg ?? '').toLowerCase() === 'ok',
    }
  } catch {
    return { success: body.includes('成功') || body.toLowerCase().includes('"msg":"ok"') }
  }
}

export async function searchXifan(uid: number, keyword: string): Promise<XifanSearchResponse> {
  const clean = keyword.trim()
  if (!clean || clean.length > XIFAN_SEARCH_MAX_LENGTH) {
    throw new Error(`搜索词长度需为 1–${XIFAN_SEARCH_MAX_LENGTH} 个字符`)
  }

  const session = sessionFor(uid)
  const firstResponse = await session.get(`${BASE_URL}/search.html?wd=${encodeURIComponent(clean)}`)
  const firstHtml = assertHtml(firstResponse)
  if (needsCaptcha(firstHtml)) return { needsCaptcha: true }

  const all: XifanSearchHit[] = parseSearchPage(firstHtml)
  let next = nextPageUrl(firstHtml)
  let pages = 1
  while (next && pages < MAX_PAGES) {
    const response = await session.get(next)
    const html = assertHtml(response)
    if (needsCaptcha(html)) return { needsCaptcha: true }
    const more = parseSearchPage(html)
    if (more.length === 0) break
    all.push(...more)
    pages++
    const following = nextPageUrl(html)
    if (following === next) break
    next = following
  }

  return { needsCaptcha: false, data: uniqueHits(all) }
}
