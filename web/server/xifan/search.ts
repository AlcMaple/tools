// 稀饭全站搜索 —— 搜索页有验证码，验证码图片、校验、搜索必须共用同一个 cookie 罐。
// 网页版按 MapleTools 登录用户隔离 cookie，避免不同用户的验证码或稀饭登录态串线。
import * as cheerio from 'cheerio/slim'
import {
  assertXifanResponse,
  BASE_URL,
  isXifanChallengePage,
  xifanSessionFor,
  type XifanHttpResponse,
} from './session'

const MAX_PAGES = 20
export const XIFAN_SEARCH_MAX_LENGTH = 100

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

function assertHtml(response: XifanHttpResponse): string {
  return assertXifanResponse(response, '稀饭搜索')
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
  return next && new URL(next).origin === new URL(BASE_URL).origin ? next : null
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
  const response = await xifanSessionFor(uid).get(`${BASE_URL}/verify/index.html?t=${Date.now()}`)
  if (response.status < 200 || response.status >= 300) {
    assertXifanResponse(response, '稀饭验证码请求')
  }
  const rawType = response.headers.get('content-type')?.split(';', 1)[0] || ''
  // SVG / HTML 不能作为验证码回传：即便前端放进 <img>，也不把可执行矢量内容
  // 当作跨边界数据交给浏览器。
  if (!/^image\/(?:png|jpe?g|gif|webp)$/i.test(rawType)) {
    const body = response.body.toString('utf8')
    if (isXifanChallengePage(body)) throw new Error('稀饭要求浏览器安全验证，请稍后再试')
    throw new Error('稀饭验证码返回了非图片内容')
  }
  return { imageB64: response.body.toString('base64'), mime: rawType }
}

export async function verifyXifanCaptcha(uid: number, code: string): Promise<{ success: boolean }> {
  const response = await xifanSessionFor(uid).get(
    `${BASE_URL}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`,
    {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  )
  const body = assertXifanResponse(response, '稀饭验证码校验')
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

  const session = xifanSessionFor(uid)
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
    pages += 1
    const following = nextPageUrl(html)
    if (following === next) break
    next = following
  }

  return { needsCaptcha: false, data: uniqueHits(all) }
}
