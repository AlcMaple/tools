import * as cheerio from 'cheerio/slim'

export interface PaginatorOptions<T> {
  firstHtml: string
  baseUrl: string
  parsePage: (html: string) => T[] | Promise<T[]>
  fetchHtml: (url: string) => Promise<string>
  delayMs?: number
  maxPages?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 跟随 MacCMS 的“下一页”链接，不自行拼分页 URL，避免不同站点编码规则不一致。 */
function getNextPageHref(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html)
  const href = $('a.page-link[title="下一页"]').attr('href') ?? ''
  if (!href || href === 'javascript:') return null
  try {
    return new URL(href, baseUrl).href
  } catch {
    return null
  }
}

export async function crawlAllPages<T>(opts: PaginatorOptions<T>): Promise<T[]> {
  const { firstHtml, baseUrl, parsePage, fetchHtml, delayMs = 1000, maxPages = 20 } = opts
  const all = await Promise.resolve(parsePage(firstHtml))
  let next = getNextPageHref(firstHtml, baseUrl)
  let page = 1

  while (next && page < maxPages) {
    await sleep(delayMs)
    let html: string
    try {
      html = await fetchHtml(next)
    } catch {
      break
    }
    const items = await Promise.resolve(parsePage(html))
    if (items.length === 0) break
    all.push(...items)
    page++
    const following = getNextPageHref(html, baseUrl)
    if (following === next) break
    next = following
  }
  return all
}
