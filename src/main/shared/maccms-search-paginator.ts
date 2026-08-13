/**
 * MacCMS 搜索结果页的共用翻页器(三个站的搜索页都是同一套模板)。
 *
 * **跟着「下一页」链接走,而不是自己拼 URL**:各站的搜索基址不一样
 * (`/vods/?wd=`、`/search.html?wd=`、`/search/----/?wd=`),分页参数的编码方式也各不相同
 * 跟链接走可以完全绕开这些差异。
 *
 * 串行 + 固定的页间延迟,别把并发打上去 —— 那会撞上站点的限流 / 验证码闸门。
 */
import * as cheerio from 'cheerio/slim'

export interface PaginatorOptions<T> {
  firstHtml: string                                 // already-fetched first page body
  baseUrl: string                                   // e.g. https://www.aowu.tv (for resolving relative hrefs)
  parsePage: (html: string) => T[] | Promise<T[]>   // extract result items from one page's HTML
  fetchHtml: (url: string) => Promise<string>       // caller-provided fetcher (handles cookies / referer / etc)
  delayMs?: number                                  // sleep between page fetches; default 1000
  maxPages?: number                                 // safety cap; default 20
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 读搜索结果页里「下一页」的 href;已经是最后一页时返回 null。 */
export function getNextPageHref(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html)
  const next = $('a.page-link[title="下一页"]').attr('href')
  if (!next || next === 'javascript:') return null
  // 最后一页的「下一页」链接常常指回当前页,所以还要求当前页之后至少存在一个编号页链接。
  const cur = $('a.page-link.b-c').attr('title') ?? ''  // e.g. "第3页"
  const curMatch = /第(\d+)页/.exec(cur)
  const nextMatch = /第(\d+)页/.exec($('a.page-link[title="下一页"]').attr('title') ?? '')
  // title 属性字面量就是「下一页」,不是「第N页」。
  void curMatch; void nextMatch
  try { return new URL(next, baseUrl).href } catch { return null }
}

/** 从已经抓到的第一页开始翻完整个搜索结果,按页序拼接返回。 */
export async function crawlAllPages<T>(opts: PaginatorOptions<T>): Promise<T[]> {
  const { firstHtml, baseUrl, parsePage, fetchHtml, delayMs = 1000, maxPages = 20 } = opts
  const all: T[] = await Promise.resolve(parsePage(firstHtml))

  let nextHref = getNextPageHref(firstHtml, baseUrl)
  let pageNum = 1
  while (nextHref && pageNum < maxPages) {
    await sleep(delayMs)
    let html: string
    try {
      html = await fetchHtml(nextHref)
    } catch {
      break  // stop on any fetch failure rather than half-stitching results
    }
    const items = await Promise.resolve(parsePage(html))
    if (items.length === 0) break  // empty page = bail (avoid loops if "下一页" points at current)
    all.push(...items)
    pageNum++
    const newNext = getNextPageHref(html, baseUrl)
    if (newNext === nextHref) break  // self-loop guard
    nextHref = newNext
  }
  return all
}
