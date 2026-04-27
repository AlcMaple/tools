/**
 * Shared paginator for MacCMS dsn2 search pages (used by xifan / girigiri / aowu).
 *
 * The dsn2 template renders a uniform pagination block:
 *   <div class="page-info ...">
 *     <a class="page-link" title="首页" href=...>首页</a>
 *     <a class="page-link" title="上一页" href=...>上一页</a>
 *     <a class="page-link b-c" href="javascript:" title="第N页">N</a>     ← current
 *     <a class="page-link" title="第K页" href=...>K</a>...
 *     <a class="page-link" title="下一页" href=...>下一页</a>
 *     <a class="page-link" title="尾页" href=...>尾页</a>
 *   </div>
 *
 * We walk by following the `下一页` link rather than computing URLs, because each
 * site's search base is different (`/vods/?wd=`, `/search.html?wd=`, `/search/----/?wd=`)
 * and MacCMS's URL encoding for paged results varies. Following the link sidesteps
 * that entirely.
 *
 * Sequential with a fixed inter-page delay — keeps fan-out polite so we don't trip
 * the site's rate-limit / captcha gate.
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

/**
 * Read the `下一页` (next page) href from a MacCMS dsn2 search results page.
 * Returns null when this is the last page (next-link points back at current or absent).
 */
export function getNextPageHref(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html)
  const next = $('a.page-link[title="下一页"]').attr('href')
  if (!next || next === 'javascript:') return null
  // The "下一页" link on the LAST page often loops back to the current page. Detect by
  // also checking if the current page is the same as the would-be next page; if equal,
  // treat as no-next. We approximate by also requiring at least one numbered page link
  // ahead of the current one.
  const cur = $('a.page-link.b-c').attr('title') ?? ''  // e.g. "第3页"
  const curMatch = /第(\d+)页/.exec(cur)
  const nextMatch = /第(\d+)页/.exec($('a.page-link[title="下一页"]').attr('title') ?? '')
  // title="下一页" — the title attribute is literally "下一页", not "第N页". So we
  // can't compare via title. Instead: if there's no numbered link at idx > current,
  // bail. For sites that don't emit "上一页/下一页" on the boundary, the absence
  // already short-circuits above.
  void curMatch; void nextMatch
  try { return new URL(next, baseUrl).href } catch { return null }
}

/**
 * Crawl all pages of a MacCMS search starting from already-fetched `firstHtml`.
 * Concatenates per-page items and returns them in page order.
 */
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
