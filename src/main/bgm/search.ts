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
import * as cheerio from 'cheerio/slim'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { safeName } from '../shared/download-types'
import { BrowserSession } from '../shared/browser-session'
import {
  RateLimiter,
  RateLimitError,
  type LimitDetector,
} from '../shared/rate-limit'
import { withTransientRetry } from '../shared/http-client'
import { netRequest } from '../shared/net-request'
import { fetchBgmApiJson } from './api-client'
// 注意：与 html-fallback 是「运行时安全」的循环依赖 —— 两边都只在异步函数体内
// 用对方的导出（fetchHtmlWithDefenses / fetchSubjectViaHtml），模块初始化期不互相
// 取值，ESM live binding 能正确解析。
import { fetchSubjectViaHtml } from './html-fallback'

/**
 * 搜索 URL 模板。`cat` 参数：
 *   - 2 = 动画（默认）
 *   - 1 = 书籍（漫画+小说+画集+其他混在一起，BGM 在 URL 层级不可拆）
 *
 * 其他 cat 值（3 音乐 / 4 游戏 / 6 三次元）当前未启用，但模板支持 ——
 * 未来要加直接传新 cat 即可，不用改 search.ts。
 */
const BASE_URL = 'https://bgm.tv/subject_search/{keyword}?cat={cat}&page={page}'

/** 当前支持的 cat 值 —— 005 阶段只接「动画 / 书籍」两个用户可见的类目。 */
export type BgmSearchCat = 1 | 2

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

/**
 * 缓存文件名按 cat 隔离：同一个关键词在动画 / 书籍 两种类目下命中的结果
 * 不一样（比如「巨虫列岛」既是动画又是漫画），缓存必须分桶不能串味。
 *
 * 命名格式：`{safeKeyword}_cat{cat}_{page}.html`
 *
 * **历史兼容**：旧版本写出的 `{safeKeyword}_{page}.html`（不含 cat 段）
 * 不再读取也不主动迁移 —— 老缓存文件留在磁盘上是无害的垃圾，下次搜同
 * 关键词时自动写一个新的带 cat 的副本，旧文件自然失效。
 */
function getCachePath(keyword: string, page: number, cat: BgmSearchCat): string {
  return join(getCacheDir(), `${safeName(keyword)}_cat${cat}_${page}.html`)
}

async function initCache(): Promise<void> {
  await fs.mkdir(getCacheDir(), { recursive: true })
}

/**
 * Read cached HTML. If the cached body turns out to be a poisoned limit page
 * (from older code that didn't sniff), delete it and report miss so the
 * caller refetches.
 */
async function readCache(keyword: string, page: number, cat: BgmSearchCat): Promise<string | null> {
  const p = getCachePath(keyword, page, cat)
  if (!existsSync(p)) return null
  const html = await fs.readFile(p, 'utf-8')
  if (detectLimit(html) != null) {
    // Poisoned — wipe and treat as miss so we refetch instead of serving garbage.
    await fs.unlink(p).catch(() => {})
    return null
  }
  return html
}

async function saveCache(html: string, keyword: string, page: number, cat: BgmSearchCat): Promise<void> {
  await fs.writeFile(getCachePath(keyword, page, cat), html, 'utf-8')
}

// ── Fetch with full defense stack ─────────────────────────────────────────────

async function rawGet(url: string): Promise<{ status: number; body: Buffer }> {
  // 走 Electron net（Chromium 网络栈）—— 自动用系统代理，修掉 Node https 直连
  // fake-ip 假地址导致的冷启动超时。net 自己解压，所以不再 decodeBody。
  const res = await netRequest(url, {
    headers: session.headers({
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    }),
    timeoutMs: 10000,
  })
  session.ingestSetCookie(res.headers as { 'set-cookie'?: string[] })
  return { status: res.status, body: res.body }
}

/**
 * 抓一次 BGM 搜索 HTML。**不做应用层自动重试** —— 失败一律抛到 UI,
 * 由 UI 通过 Try again 按钮 / 倒计时按钮承担重试职责。这样：
 *
 *   - 用户始终知道发生了什么（不是黑盒等几十秒）
 *   - 限流期间永远不会因为代码自动重试加剧惩罚
 *   - 代码大幅简化（去掉 5xx retry + withRateLimitRetry 两层嵌套）
 *
 * 唯一保留的"代码层重试"是 `withTransientRetry`（200-500ms 内 ECONNRESET
 * 这类瞬时 socket 错误），这是网络层真透明恢复，用户根本感知不到。
 *
 * 错误分类：
 *   - 限流页 body  → 抛 `RateLimitError(waitSec)`，UI 展示倒计时
 *   - HTTP 429    → 抛 `RateLimitError(30)`（BGM 几乎不返 429，但兜底）
 *   - HTTP 5xx    → 抛 `Error("BGM 返回 HTTP {n}")`，UI 展示「BGM 偶发故障」+ Try again
 *   - 其他 4xx    → 抛 `Error("BGM 返回 HTTP {n}")`
 *   - 网络层异常   → 透传给上层 friendly classifier
 */
export async function fetchHtmlWithDefenses(url: string): Promise<string> {
  return limiter.schedule(async () => {
    const r = await withTransientRetry(() => rawGet(url))
    if (r.status === 429) {
      throw new RateLimitError(30, 'BGM 返回 HTTP 429，触发限流')
    }
    if (r.status >= 400) {
      throw new Error(`BGM 返回 HTTP ${r.status}`)
    }
    const body = r.body.toString('utf-8')
    // 限流页 body 检测 —— BGM 搜索经常返 200 + 中文"您在 N 秒内只能进行
    // 一次搜索"。检测到立刻抛 RateLimitError 让 UI 倒计时，**不**自动等待
    // + 重试（自动重试反而吃掉用户的反馈机会、可能加剧惩罚）。
    const waitSec = detectLimit(body)
    if (waitSec != null) {
      throw new RateLimitError(waitSec, `BGM 触发限流，请等 ${waitSec} 秒后再试`)
    }
    return body
  })
}

/**
 * 拉一页搜索结果。
 *
 * 成功时返回 HTML 字符串。**所有失败一律 throw**：
 * - `RateLimitError`     站点限流（带 waitSec，UI 据此显示倒计时）
 * - 普通 Error             网络挂 / 超时 / 5xx / 4xx 等其他失败
 *
 * 之前这里把非 RateLimitError 都吞成 `null` 返回，结果 caller 拿到 null 时
 * 不知道是"网络问题"还是"页面其实是空"，统一抛个 "网络请求失败" 误导用户。
 * 现在让 caller 拿到原始 Error，由 caller 决定 page=1 致命 / page≥2 跳过。
 */
async function fetchPage(
  keyword: string,
  page: number,
  update: boolean,
  cat: BgmSearchCat,
): Promise<string> {
  if (!update) {
    const cached = await readCache(keyword, page, cat)
    if (cached) return cached
  }

  const url = BASE_URL
    .replace('{keyword}', encodeURIComponent(keyword))
    .replace('{cat}', String(cat))
    .replace('{page}', String(page))

  // fetchHtmlWithDefenses 已经做了限流页检测 —— 这里拿到的 html 一定是干净
  // 的搜索结果页，可以安全 saveCache。
  const html = await fetchHtmlWithDefenses(url)
  await saveCache(html, keyword, page, cat)
  return html
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
 * 共用 api.bgm.tv 的 RateLimiter（500ms 间隔）—— 多条 alias 串行后总耗时
 * 仍可控（8 条 ≈ 4s），换来 IP 不被限流。
 *
 * 失败时返回空数组（网络抖 / 404 / 限流），让 caller 跳过这条而不是整个
 * 搜索崩掉 —— 别名回退本来就是 best-effort 增强，**绝不**升级成致命错误。
 */
async function fetchAliases(subjectId: number): Promise<string[]> {
  if (!subjectId) return []
  let infobox: Array<{ key: string; value: unknown }>
  try {
    const data = await fetchBgmApiJson<Record<string, unknown>>(
      `https://api.bgm.tv/v0/subjects/${subjectId}`,
    )
    infobox = (data.infobox ?? []) as Array<{ key: string; value: unknown }>
  } catch (e) {
    if (e instanceof RateLimitError) {
      // 限流冷却中 → 降级抓 bgm.tv HTML 拿别名（同形 infobox），让按中文别名
      // 搜索在冷却期仍能命中。HTML 也失败就静默跳过（别名回退是 best-effort）。
      try {
        const data = await fetchSubjectViaHtml(subjectId)
        infobox = data.infobox
      } catch {
        return []
      }
    } else {
      // 非限流错误（网络抖 / 404 等）—— best-effort，静默跳过，不升级成"搜索失败"
      return []
    }
  }
  const entry = infobox.find((e) => e.key === '别名')
  if (!entry) return []
  if (typeof entry.value === 'string') return [entry.value]
  if (Array.isArray(entry.value)) {
    return entry.value
      .map((v) => String((v as { v?: string }).v ?? ''))
      .filter(Boolean)
  }
  return []
}

/**
 * 分页早停：连续多少页「整页没有任何 visibleMatch（主标题/副标题命中关键词）」
 * 后停止翻页。BGM 按相关度排序，真命中聚在前几页，命中带结束后剩下的全是
 * 字符碎片模糊命中的噪声 —— 再硬翻几十页既拿不到有效结果，每页还要在限流
 * 红线上等 ~2.5s 反复试探（搜「光之美少女」命中带 8 页、totalPages 却有 82,
 * 旧逻辑会把 9-82 页全抓一遍 ≈ 3 分钟纯浪费 + 限流风险）。
 *
 * 阈值 2 容忍命中带中间偶发的一页空档，命中带结束后最多多抓 2 页就收尾。
 *
 * 别名搜索（visibleMatch 全程为空）也吃这条规则、会在第 2 页就早停 —— 这
 * **正好**：别名回退靠「连续 miss 早停」沿命中带扫，第 1 页通常就够。
 * 早停前用 gate 保证至少攒够 ALIAS_LOOKUP_MIN_CANDIDATES 条候选才停（见 searchBgm）。
 */
const EARLY_STOP_PAGES_WITHOUT_VISIBLE_MATCH = 2

/**
 * 别名回退的主限制器：**连续** miss 多少次后早停。BGM 把别名命中按相关度排在
 * 前面，命中聚成一个「命中带」，连撞 N 个 miss 说明已经走出命中带、进入字符
 * 碎片模糊命中区，再查也是浪费。计数器在每次 hit 时重置 —— 容忍
 * hit / miss / miss / hit / ... 的交错，沿整条命中带扫到底。
 *
 * 008 之前用 `slice(0, N)` 死板砍候选池当主限制器，结果头部一个热门噪声条目
 * （如搜「谭雅战记」时 BGM 把高人气的「罗小黑战记2」排第 1）就占掉一个名额，
 * 把真命中（「幼女战记 第二季」）挤出窗口、压根没机会验别名。改用连续-miss
 * 早停后，噪声只消耗「连续 miss 预算」、命中则重置，命中带多长就扫多长 ——
 * 该省的 API 全省在噪声上，不再误伤命中。**这是别名回退唯一的 per-search 限制器**。
 *
 * 为什么不再额外加一个「最多查 N 条」的硬上限：那会重新引入「砍候选池 = 砍召回」
 * 的老问题（纯别名的大系列会被截断、漏番）。失控扫描（hit/miss/hit/miss 交错永远
 * 触发不了连续-miss 早停）由 008 的全局护栏兜底 —— L2 滚动窗口（60s ≤20 个
 * api.bgm.tv）会阻塞超额请求、L3 熔断会在真撞限流时降级，**不靠这里砍召回**。
 * 加上分页早停把纯别名搜索的候选池天然限制在 ~2 页（见上），扫描量本就有界。
 */
const ALIAS_LOOKUP_MAX_CONSECUTIVE_MISSES = 3
/**
 * 分页早停前，至少要攒够多少条 unmatched 候选才允许停翻页 —— 保证别名回退
 * 有足够材料可扫（否则第 1 页结果太少时过早停掉、命中带还没扫完）。这是个
 * 下限 floor，攒更多也无妨；实际 BGM 单页约 25 条，绝大多数搜索第 1 页就远超它。
 */
const ALIAS_LOOKUP_MIN_CANDIDATES = 4

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
  cat: BgmSearchCat = 2,
): Promise<BgmSearchResult[]> {
  await initCache()

  // 第一页必须成功 —— 失败直接把原始错误抛上去，UI 的 errorMessage 分类器
  // 会按错误类型显示「BGM 限流」/「连不上服务器」/「服务器异常」等具体提示
  // （比以前的"网络请求失败"通用误导文案准确多了）。
  const html1 = await fetchPage(keyword, 1, update, cat)

  const totalPages = parseTotalPages(html1)
  onProgress?.(1, totalPages)

  // 每条 item 标上它来自第几页 —— 别名回退的「近命中保留」要按页区分：触发
  // 连续-miss 早停时只回收**触发页**上的 miss，上一页/更早页的 miss 不算。
  const page1Items = parsePage(html1, keyword).map((it) => ({ ...it, page: 1 }))
  if (page1Items.length === 0) return []

  const allItems = [...page1Items]

  // 早停状态：visibleCount 累计有视觉命中的条目数，consecutiveNoVisible 是
  // 连续「整页无 visibleMatch」的页数。命中带结束后快速收尾，不再硬翻到
  // totalPages（见 EARLY_STOP_PAGES_WITHOUT_VISIBLE_MATCH 注释）。
  let visibleCount = page1Items.filter((x) => x.visibleMatch).length
  let consecutiveNoVisible = visibleCount > 0 ? 0 : 1

  for (let page = 2; page <= totalPages; page++) {
    // 后续页面用 try/catch 区分：限流要中断整个搜索（继续抓只会加重惩罚）,
    // 其他临时错误（5xx / timeout / 网络抖）跳过当前页继续 —— 反正已经
    // 有 page1 的结果可用，不能因为 page 4 抖一下就把整个搜索废掉。
    let html: string
    try {
      html = await fetchPage(keyword, page, update, cat)
    } catch (e) {
      if (e instanceof RateLimitError) throw e
      onProgress?.(page, totalPages)
      continue
    }
    onProgress?.(page, totalPages)

    const items = parsePage(html, keyword).map((it) => ({ ...it, page }))
    if (items.length === 0) break

    allItems.push(...items)

    // 早停判定 —— 放在 push 之后：本页结果一定收进 allItems，再决定要不要
    // 继续翻下一页。
    const pageVisible = items.filter((x) => x.visibleMatch).length
    visibleCount += pageVisible
    consecutiveNoVisible = pageVisible > 0 ? 0 : consecutiveNoVisible + 1

    // gate：别名回退路径（visibleCount 全程为 0）要至少攒够
    // ALIAS_LOOKUP_MIN_CANDIDATES 条候选才允许早停，避免第 1 页结果太少时
    // 过早停掉、导致别名回退没东西可查。
    const unmatchedCount = allItems.length - visibleCount
    if (
      consecutiveNoVisible >= EARLY_STOP_PAGES_WITHOUT_VISIBLE_MATCH &&
      (visibleCount > 0 || unmatchedCount >= ALIAS_LOOKUP_MIN_CANDIDATES)
    ) {
      break
    }
  }

  // 单遍按 BGM 相关度顺序处理 allItems，每条三选一：
  //   1. 标题 / 日文副标题命中关键词 → 直接收（零 API），重置连续 miss 计数
  //   2. 标题没命中 → 验别名：别名命中 → 收，重置；**标题和别名都没命中 = miss**
  //   3. 连续 N 个 miss → 触发「近命中保留」并停止再验别名（之后的可见命中仍照收）
  //
  // 「近命中保留」（用户拍板）：用户常按「俗称 / 大众名」或「系列名」搜，想要的续作 /
  // 同系列（如搜「黑之契约者」想要的「DARKER THAN BLACK –流星的双子–」）标题和别名
  // 可能都不含这个词、本会被当 miss 过滤掉 —— 但它紧挨命中带、通常正是用户想要的。
  // 规则：被「连续 N 个 miss」早停时，把**触发那一页**上已检查过的 miss 也一并当结果
  // 返回（含触发的 streak + 同页更早的零星 miss）。只限触发页：上一页 / 更早页的 miss
  // 离命中带更远、不回收（item 在 parsePage 后标了 page 字段）。锚点 `sawHit`：本次
  // 确实命中过（可见或别名）才回收，避免「整页零命中」的搜索返回一整页纯噪声。
  //
  // API 用量：只有「标题没命中」的条目才验别名，且连撞 N 个 miss 即停 —— 标题直接
  // 命中的零 API，命中带后面通常 N 个就早停。不用 `slice(0,N)` 候选池硬帽（会让头部
  // 热门噪声占名额、漏掉真命中，如「谭雅战记」漏「幼女战记 第二季」）。失控扫描由
  // 008 全局护栏（L2 滚动窗口 + L3 熔断）+ 分页早停（候选池天然 ~2 页）兜底。
  const kwNorm = normalizeForMatch(keyword) || keyword.toLowerCase()
  const matched: typeof allItems = []
  const examinedMisses: typeof allItems = []
  let consecutiveMisses = 0
  let stoppedByMissStreak = false
  let breakPage = 0
  let sawHit = false
  for (const x of allItems) {
    if (x.visibleMatch) {
      matched.push(x)
      consecutiveMisses = 0
      sawHit = true
      continue
    }
    // 已触发早停 → 不再验别名 / 不再累计 miss，但循环继续以收下后面的可见命中。
    if (stoppedByMissStreak) continue
    // 标题没命中 → 验别名。别名也没命中才算 miss。
    const aliases = await fetchAliases(x.subjectId)
    const aliasHit = aliases.some((a) => normalizeForMatch(a).includes(kwNorm))
    if (aliasHit) {
      matched.push(x)
      consecutiveMisses = 0
      sawHit = true
    } else {
      examinedMisses.push(x)
      consecutiveMisses++
      if (consecutiveMisses >= ALIAS_LOOKUP_MAX_CONSECUTIVE_MISSES) {
        stoppedByMissStreak = true
        breakPage = x.page
      }
    }
  }
  if (stoppedByMissStreak && sawHit) {
    for (const m of examinedMisses) {
      if (m.page === breakPage) matched.push(m)
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
