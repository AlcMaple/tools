/**
 * BGM (bgm.tv) subject search — HTML scraping with rate-limit defense.
 *
 * Three layers protect us from bgm.tv's per-IP search throttle. The site
 * rejects pacing tighter than ~2s with HTTP 200 + an in-body Chinese message
 * ("您在 N 秒内只能进行一次搜索"). Once tripped, all subsequent searches in
 * the penalty window also fail, so the only safe approach is to *never* trip
 * the limit in the first place.
 *
 *   Layer 1 — timing throttle (shared RateLimiter)
 *     ≥2200ms gap between request starts + 0-600ms jitter. The floor is set
 *     above bgm.tv's 2000ms threshold with ~200ms margin for network jitter;
 *     the jitter keeps cadence non-regular.
 *
 *   Layer 2 — browser fingerprint (shared BrowserSession)
 *     Chrome UA pool + sec-ch-ua + sec-fetch-* (navigation posture) + Accept
 *     for HTML + cookie jar. Independent from aowu's cookie jar.
 *
 *   Layer 3 — limit-page detection + cache poison guard
 *     On every fetch we sniff the body for the "您在 N 秒" message. If hit,
 *     we sleep N + 2-6s jitter and retry once; if STILL limited, we throw a
 *     RateLimitError that the renderer surfaces as a friendly message. Limit
 *     pages NEVER reach saveCache (and on read, we also delete any
 *     pre-existing poisoned files left over from older code paths).
 */
import * as https from 'node:https'
import { URL } from 'node:url'
import * as cheerio from 'cheerio/slim'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { safeName } from '../shared/download-types'
import { BrowserSession } from '../shared/browser-session'
import {
  RateLimiter,
  RateLimitError,
  withRateLimitRetry,
  type LimitDetector,
} from '../shared/rate-limit'
import { decodeBody, withTransientRetry } from '../shared/http-client'

const BASE_URL = 'https://bgm.tv/subject_search/{keyword}?cat=2&page={page}'

// ── Defense layers ────────────────────────────────────────────────────────────

const session = new BrowserSession({
  host: 'bgm.tv',
  baseUrl: 'https://bgm.tv',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  secFetchSite: 'same-origin',
  secFetchMode: 'navigate',
  secFetchDest: 'document',
})

// 2200ms hard floor (above bgm.tv's ~2000ms threshold with ~200ms network-
// jitter margin) + 0-600ms random for non-regular cadence. Effective window
// 2200-2800ms. A 5-page search lands around ~10s — slower than naive 1000ms
// pacing but the only way to avoid the 30s+ penalty box.
const limiter = new RateLimiter({
  minGapMs: 2200,
  jitterMs: 600,
  name: 'bgm',
})

/**
 * Detect bgm.tv's in-body limit message. Returns wait-seconds when the page
 * is a limit response, null when the body is normal search results.
 *
 * Forms we've seen:
 *   "对不起，您在 30 秒内只能进行一次搜索"      ← typical
 *   "您在  秒内只能进行一次搜索"                ← occasionally empty N
 *
 * We match both and fall back to a 30s default for the empty-N case (the
 * actual penalty is usually ~30s in our observations).
 */
const detectLimit: LimitDetector = (html) => {
  const m = html.match(/您在\s*(\d+)\s*秒内只能进行一次搜索/)
  if (m) return parseInt(m[1])
  if (/只能进行一次搜索/.test(html)) return 30
  return null
}

// ── Cache (disk HTML cache, keyed by keyword+page) ────────────────────────────

function getCacheDir(): string {
  return join(app.getPath('userData'), 'bgm_cache')
}

function getCachePath(keyword: string, page: number): string {
  return join(getCacheDir(), `${safeName(keyword)}_${page}.html`)
}

async function initCache(): Promise<void> {
  await fs.mkdir(getCacheDir(), { recursive: true })
}

/**
 * Read cached HTML. If the cached body turns out to be a poisoned limit page
 * (from older code that didn't sniff), delete it and report miss so the
 * caller refetches.
 */
async function readCache(keyword: string, page: number): Promise<string | null> {
  const p = getCachePath(keyword, page)
  if (!existsSync(p)) return null
  const html = await fs.readFile(p, 'utf-8')
  if (detectLimit(html) != null) {
    // Poisoned — wipe and treat as miss so we refetch instead of serving garbage.
    await fs.unlink(p).catch(() => {})
    return null
  }
  return html
}

async function saveCache(html: string, keyword: string, page: number): Promise<void> {
  await fs.writeFile(getCachePath(keyword, page), html, 'utf-8')
}

// ── Fetch with full defense stack ─────────────────────────────────────────────

function rawGet(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: session.headers({
          'sec-fetch-user': '?1',
          'upgrade-insecure-requests': '1',
        }),
      },
      (res) => {
        session.ingestSetCookie(res.headers as { 'set-cookie'?: string[] })
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: decodeBody(res.headers, Buffer.concat(chunks)),
            })
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.setTimeout(10000, () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Fetch one URL through all three defense layers. Throws on rate-limit
 * (after one in-band retry) or on hard HTTP failures; returns HTML otherwise.
 */
async function fetchHtmlWithDefenses(url: string): Promise<string> {
  return limiter.schedule(() =>
    withRateLimitRetry(
      async () => {
        const r = await withTransientRetry(() => rawGet(url))
        if (r.status === 429) {
          // bgm.tv almost never actually returns 429 — it uses the in-body
          // message instead — but if it ever does, surface it the same way.
          throw new RateLimitError(30, 'BGM 返回 HTTP 429，触发限流')
        }
        if (r.status >= 500) {
          throw new Error(`BGM 返回 HTTP ${r.status}`)
        }
        return r.body.toString('utf-8')
      },
      detectLimit,
      // Site typically asks for ~30s — add 2-6s jitter on top so we don't
      // come back exactly on the countdown.
      { jitterSecMin: 2, jitterSecMax: 6 },
    ),
  )
}

async function fetchPage(
  keyword: string,
  page: number,
  update: boolean,
): Promise<string | null> {
  if (!update) {
    const cached = await readCache(keyword, page)
    if (cached) return cached
  }

  const url = BASE_URL.replace('{keyword}', encodeURIComponent(keyword)).replace(
    '{page}',
    String(page),
  )

  try {
    const html = await fetchHtmlWithDefenses(url)
    // Defense-in-depth: detector also runs INSIDE withRateLimitRetry, but if
    // the retry succeeded we have a clean body here. saveCache is unreachable
    // for limit pages by construction.
    await saveCache(html, keyword, page)
    return html
  } catch (e) {
    // Rate-limit errors must propagate so the UI shows the right message.
    if (e instanceof RateLimitError) throw e
    // Transient/timeout errors → soft-fail. Caller decides whether to retry.
    return null
  }
}

// ── HTML parsers ──────────────────────────────────────────────────────────────

export interface BgmSearchResult {
  title: string
  date: string
  rate: string
  link: string
}

function parseTotalPages(html: string): number {
  const $ = cheerio.load(html)
  const pageNums: number[] = []
  $('#multipage a.p').each((_, el) => {
    const href = $(el).attr('href') ?? ''
    const m = href.match(/page=(\d+)/)
    if (m) pageNums.push(parseInt(m[1]))
  })
  return pageNums.length > 0 ? Math.max(...pageNums) : 1
}

function parseDate(text: string): { dateObj: Date; dateStr: string } {
  let m: RegExpMatchArray | null

  m = text.match(/(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?/)
  if (m) {
    const y = parseInt(m[1])
    const mo = parseInt(m[2])
    const d = m[3] ? parseInt(m[3]) : 1
    return { dateObj: new Date(y, mo - 1, d), dateStr: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
  }

  m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) {
    const [y, mo, d] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])]
    return { dateObj: new Date(y, mo - 1, d), dateStr: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
  }

  m = text.match(/(\d{4})/)
  if (m) {
    return { dateObj: new Date(parseInt(m[1]), 0, 1), dateStr: `${m[1]}-01-01` }
  }

  return { dateObj: new Date(0), dateStr: '未知日期' }
}

/**
 * Normalize a string for whitespace/punctuation-insensitive matching:
 *   - lowercase
 *   - strip all whitespace (\s)
 *   - strip Unicode punctuation (\p{P}) and symbols (\p{S})
 *
 * The intent is that the user shouldn't have to remember whether the official
 * title spells it "Love Live!" or "LoveLive!" or "love-live". CJK and Japanese
 * kana fall under \p{L} (letters), so Chinese / Japanese titles are unaffected.
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 解析一页搜索结果 HTML 成结构化数组。每条 item 多带一个 `visibleMatch` 字段:
 * 标记 主标题 / `<small.grey>` 日文副标题 里是否能（normalize-insensitive 地）
 * 命中关键词。
 *
 * BGM 服务端搜索是宽匹配 ——「魔女的考验」会拉回所有含"魔"/"女"字符的结果,
 * 包括"黑猫与魔女的教室""魔法少女奈叶"这种字符碎片命中的。但 HTML 里**只
 * 渲染主标题 + 一个日文 / 英文副标题**，BGM 真正按别名命中的 Chinese alias
 * 不出现在 HTML 中。
 *
 * 解决方案：两段式处理
 *   1. 这里先标 visibleMatch —— 主标题 / 副标题文本能命中的，是 BGM 宽匹配
 *      里"真正有视觉证据"的那部分。这是绝大多数搜索的主路径。
 *   2. visibleMatch 全空时（用户明显是按 Chinese alias 搜的），searchBgm
 *      回退到 BGM API 别名查询，针对 BGM 排名靠前的 unmatched 条目逐个验。
 *
 * 把 visibleMatch 标在 parsePage 里而不是 searchBgm 里，是为了 dateObj /
 * rate / link 这些字段只需要从 HTML 抽一次，下游分组用同一个对象。
 */
function parsePage(
  html: string,
  keyword: string,
): Array<BgmSearchResult & { dateObj: Date; subjectId: number; visibleMatch: boolean }> {
  const $ = cheerio.load(html)
  const results: Array<
    BgmSearchResult & { dateObj: Date; subjectId: number; visibleMatch: boolean }
  > = []
  const kwNorm = normalizeForMatch(keyword) || keyword.toLowerCase()

  $('#browserItemList li.item').each((_, el) => {
    const a = $(el).find('h3 > a.l')
    if (!a.length) return

    const title = a.text().trim()
    // BGM 主标题旁边的 <small.grey> —— 通常是日文 / 英文原标题。把它也纳入
    // visibleMatch 范围，让搜"シュガシュガルーン"这种日文名也能直接命中。
    const smallText = $(el).find('h3 > small.grey').text().trim()
    const infoText = $(el).find('p.info.tip').text().trim()
    const { dateObj, dateStr } = parseDate(infoText)
    const rate = $(el).find('p.rateInfo small.fade').text().trim() || 'N/A'
    const href = a.attr('href') ?? ''
    const idMatch = href.match(/\/subject\/(\d+)/)
    const subjectId = idMatch ? parseInt(idMatch[1]) : 0

    const visibleText = normalizeForMatch(title + smallText)
    const visibleMatch = visibleText.includes(kwNorm)

    results.push({
      title,
      date: dateStr,
      dateObj,
      rate,
      link: href.startsWith('http') ? href : `https://bgm.tv${href}`,
      subjectId,
      visibleMatch,
    })
  })

  return results
}

// ── BGM API alias lookup (回退分支用) ────────────────────────────────────────

/**
 * 从 BGM API 拉一个 subject 的「别名」字段。
 *
 * 用 api.bgm.tv 而非抓详情页 HTML —— JSON 比 cheerio scrape 快、字段干净,
 * 而且这是 detail.ts 已经在用的端点。
 *
 * BGM 的 infobox 是 `[{key, value}]` 数组，value 可能是 string 或
 * `[{v: string}]` 数组（同一字段多别名）。两种形态都归一成 string[]。
 *
 * 失败时返回空数组（网络抖 / 404 / 限流），让 caller 跳过这条而不是整个
 * 搜索崩掉。
 */
async function fetchAliases(subjectId: number): Promise<string[]> {
  if (!subjectId) return []
  return new Promise<string[]>((resolve) => {
    const url = `https://api.bgm.tv/v0/subjects/${subjectId}`
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'tools/1.0 (github.com/user/tools)',
          'Accept': 'application/json',
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          res.resume()
          resolve([])
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
            const infobox = (data.infobox ?? []) as Array<{ key: string; value: unknown }>
            const entry = infobox.find((e) => e.key === '别名')
            if (!entry) {
              resolve([])
              return
            }
            if (typeof entry.value === 'string') {
              resolve([entry.value])
              return
            }
            if (Array.isArray(entry.value)) {
              resolve(
                entry.value
                  .map((v) => String((v as { v?: string }).v ?? ''))
                  .filter(Boolean),
              )
              return
            }
            resolve([])
          } catch {
            resolve([])
          }
        })
      },
    )
    req.on('error', () => resolve([]))
    req.setTimeout(8000, () => {
      req.destroy()
      resolve([])
    })
    req.end()
  })
}

/** 最多查多少条 BGM 排名靠前的 unmatched 条目的别名 —— 防止 API 调用爆炸。 */
const ALIAS_LOOKUP_LIMIT = 8
/**
 * 连续 miss 多少次后早停。BGM 把别名命中按相关度排在前面，连查 N 个都没
 * 命中说明已经走出"别名命中带"进入"字符碎片模糊命中"区，再查也是浪费。
 * 计数器在每次 hit 时重置 —— 容忍 hit / miss / miss / hit / ... 的交错。
 */
const ALIAS_LOOKUP_MAX_CONSECUTIVE_MISSES = 3

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Optional callback fired after each page is fetched (cache hit or network).
 * Lets the renderer show "fetching page X of Y" while a multi-page search runs.
 * `current` is 1-indexed; `total` is the total page count detected from page 1.
 */
export type SearchProgressCallback = (current: number, total: number) => void

export async function searchBgm(
  keyword: string,
  update = false,
  onProgress?: SearchProgressCallback,
): Promise<BgmSearchResult[]> {
  await initCache()

  const html1 = await fetchPage(keyword, 1, update)
  if (!html1) throw new Error('网络请求失败，请检查网络连接后重试')

  const totalPages = parseTotalPages(html1)
  onProgress?.(1, totalPages)

  const page1Items = parsePage(html1, keyword)
  if (page1Items.length === 0) return []

  const allItems = [...page1Items]

  for (let page = 2; page <= totalPages; page++) {
    const html = await fetchPage(keyword, page, update)
    onProgress?.(page, totalPages)
    if (!html) continue

    const items = parsePage(html, keyword)
    if (items.length === 0) break

    allItems.push(...items)
  }

  // 两段式过滤：
  //   1. 按 visibleMatch（主标题 / 日文副标题命中）筛 —— 大多数搜索这步就足够
  //   2. 如果 visibleMatch 全空（用户搜的是 Chinese alias），回退到 BGM API
  //      别名查询，针对 BGM 排名靠前的 unmatched 条目逐个验
  //
  // 这样搜「魔界女王候补生」走第 1 步直接命中主标题，搜「魔女的考验」走第 2
  // 步通过 API 查到「魔界女王候补生」的 Chinese alias 含此关键词，两个查询
  // 都收敛到同一条结果。
  const matched: typeof allItems = []
  const unmatched: typeof allItems = []
  for (const x of allItems) {
    if (x.visibleMatch) matched.push(x)
    else unmatched.push(x)
  }

  // visibleMatch 全空 → 别名回退。只查 BGM 排名前 N 条（BGM 自己把别名匹配
  // 排在最前面，越往后越是字符碎片命中的噪声）。失败 / 不含关键词的条目
  // 静默跳过；命中的加入 matched 走最终的去重 + 日期排序。
  //
  // 早停：连续 N 次 miss 直接 break —— 已经走出别名命中带，剩下几位都查
  // 也是浪费 API 调用。计数器在每次 hit 时重置，所以 hit/miss 交错的情况
  // 仍能扫到底（最常见就是位置 1-2 同主题不同季都有相同 alias）。
  if (matched.length === 0) {
    const kwNorm = normalizeForMatch(keyword) || keyword.toLowerCase()
    const candidates = unmatched.slice(0, ALIAS_LOOKUP_LIMIT)
    let consecutiveMisses = 0
    for (const c of candidates) {
      const aliases = await fetchAliases(c.subjectId)
      const aliasHit = aliases.some((a) => normalizeForMatch(a).includes(kwNorm))
      if (aliasHit) {
        matched.push(c)
        consecutiveMisses = 0
      } else {
        consecutiveMisses++
        if (consecutiveMisses >= ALIAS_LOOKUP_MAX_CONSECUTIVE_MISSES) break
      }
    }
  }

  // 去重 + 按日期排序（沿用旧行为：最新的番剧在最上面）。
  const seen = new Set<string>()
  const deduped = matched.filter((x) => {
    if (seen.has(x.title)) return false
    seen.add(x.title)
    return true
  })
  deduped.sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime())

  return deduped.map(({ title, date, rate, link }) => ({ title, date, rate, link }))
}
