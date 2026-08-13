/**
 * bgm.tv 条目搜索 —— HTML 抓取 + 限流防御。
 *
 * 站点对 ~2s 以内的连发返回 HTTP 200 + 正文「您在 N 秒内只能进行一次搜索」,而且一旦触发
 * 惩罚窗口内的后续搜索也全废 —— 所以唯一安全的做法是**从不触发**:
 *
 *   1. 限速:间隔 ≥2200ms + 抖动(站点阈值 2000ms,留 200ms 网络余量)。
 *   2. 浏览器指纹:BrowserSession(UA 池 + sec-ch-ua + sec-fetch-* + 独立 cookie jar)。
 *   3. 限流页识别:命中就抛 `RateLimitError` 交给 UI 倒计时,**不自动重试**;限流页
 *      **永远不进缓存**(读缓存时还会顺手删掉旧代码留下的中毒文件)。
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
import { logInfo } from '../shared/logger'
import {
  DESKTOP_USER_AGENT,
  DESKTOP_SEC_CH_UA,
  DESKTOP_SEC_CH_UA_PLATFORM,
} from '../shared/download-types'
import { fetchBgmApiJson } from './api-client'
import { getBgmCookie } from './credentials'
// 与 html-fallback 是循环依赖,但运行时安全:两边都只在异步函数体内用对方的导出
// 模块初始化期不互相取值。
import { fetchSubjectViaHtml } from './html-fallback'

/** `cat`:2 = 动画,1 = 书籍(漫画/小说/画集混在一起,BGM 在 URL 层级不可拆)。 */
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

// 搜索页（bgm.tv/subject_search）只有 HTML 这一条路、没有 API 兜底，所以**不**做
// 熔断阻断（阻断会让冷却期的 Try again 短路成空点击，违背「Try again 永远能真的
// 重试」）。这里只做「连续超时 → 给个信息性倒计时」：BGM 搜索被严重限流时直接
// 丢包 → 表现为连续超时（区别于「您在 N 秒内只能搜一次」那种拿得到响应的短限流页）。
// 单次超时当网络抖（普通报错、不倒计时）；连撞阈值才判定疑似限流、给倒计时提示，
// 但**不阻断**——用户点 Try again 仍会真的重新发起搜索（风险自负）。
let consecutiveSearchTimeouts = 0
const SEARCH_TIMEOUT_TRIP_THRESHOLD = 2
// 疑似限流时给 UI 的建议等待秒数（仅提示，Try again 不禁用）。BGM 不告诉我们真实
// 惩罚窗口，给个温和的默认值即可。
const SEARCH_LIMIT_HINT_SEC = 60

/**
 * 识别正文里的限流提示,是限流页就返回还要等几秒,正常结果页返回 null。
 *
 * 见过两种写法:「对不起,您在 30 秒内只能进行一次搜索」和秒数为空的「您在  秒内…」。
 * 两种都认;秒数为空时按 30 秒兜底(实测惩罚大致就是这个量级)。
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
 * 读缓存的 HTML。若缓存里存的其实是被投毒的限流页(旧代码没做识别时写进去的),删掉文件并
 * 当未命中,让调用方重新抓。
 */
async function readCache(keyword: string, page: number, cat: BgmSearchCat): Promise<string | null> {
  const p = getCachePath(keyword, page, cat)
  if (!existsSync(p)) return null
  const html = await fs.readFile(p, 'utf-8')
  if (detectLimit(html) != null) {
    // 有毒 —— 删掉并当未命中,重新抓,别把垃圾喂给用户。
    await fs.unlink(p).catch(() => {})
    return null
  }
  return html
}

async function saveCache(html: string, keyword: string, page: number, cat: BgmSearchCat): Promise<void> {
  await fs.writeFile(getCachePath(keyword, page, cat), html, 'utf-8')
}

// ── Fetch with full defense stack ─────────────────────────────────────────────

/** 合并两段 Cookie 头串(`a=b; c=d`),后者(extra)同名覆盖前者。 */
function mergeCookieHeader(base: string | undefined, extra: string): string {
  const map = new Map<string, string>()
  for (const src of [base ?? '', extra]) {
    for (const part of src.split(';')) {
      const i = part.indexOf('=')
      if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
    }
  }
  return Array.from(map, ([k, v]) => `${k}=${v}`).join('; ')
}

async function rawGet(
  url: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  // 走 Electron net（Chromium 网络栈）—— 自动用系统代理，修掉 Node https 直连
  // fake-ip 假地址导致的冷启动超时。net 自己解压，所以不再 decodeBody。
  const headers = session.headers({
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  })
  // 带上网页登录 cookie（用户在设置里点过「登录 BGM」就有）。登录态下 bgm.tv
  // 搜索 ~0.6s 秒回；匿名会被故意拖慢到 ~16s。登录 cookie 同名覆盖 jar 里的旧值。
  const loginCookie = getBgmCookie()
  if (loginCookie) {
    headers['Cookie'] = mergeCookieHeader(headers['Cookie'], loginCookie)
    // BGM 把登录态绑定在登录时的 UA 上（实测：同 cookie 同 IP，仅换 UA 即被当匿
    // 名）。带登录 cookie 时必须用登录窗同款固定 UA 顶掉 jar 的随机伪装 UA，否则
    // 登录 cookie 形同虚设。未登录时保持随机伪装不变。
    headers['User-Agent'] = DESKTOP_USER_AGENT
    // sec-ch-ua 一并对齐——只换 UA 不换客户端提示会造成 (UA, sec-ch-ua) 版本
    // 自相矛盾的指纹（jar 变体是随机 Chrome 119~123，UA 却固定 120），比不发更
    // 可疑；DESKTOP_USER_AGENT 又写死 Windows，在 macOS 上还会平台对不上。
    headers['sec-ch-ua'] = DESKTOP_SEC_CH_UA
    headers['sec-ch-ua-platform'] = DESKTOP_SEC_CH_UA_PLATFORM
  }
  const res = await netRequest(url, {
    headers,
    // 25s 而非 10s：bgm.tv 对**匿名**搜索是「故意拖慢」而非拒绝 —— 实测同 IP 同时
    // 刻,登录态 0.6s 秒回,匿名要 ~16s 才回包(都是 200)。app 是匿名请求,10s
    // 超时会在 16s 响应到达前就掐断 → 误报「请求超时」。给到 25s 让匿名响应能等到。
    // (要彻底变快得让请求带登录 cookie,那是另一条路;这里先保证「能搜到」。)
    timeoutMs: 25000,
  })
  session.ingestSetCookie(res.headers as { 'set-cookie'?: string[] })
  return { status: res.status, headers: res.headers, body: res.body }
}

/**
 * 【临时诊断,查清 502 成因后可删】把失败响应的关键信号拼成一行,判断是 Cloudflare 盾
 * 挑战还是纯 CDN 网关错误。既打 main 控制台也塞进抛出的 Error —— 打包后用户看不到
 * main 日志,但能把 UI 的「Show details」截图给开发者。
 */
function diagnoseFailure(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): string {
  const h = (k: string): string => {
    const v = headers[k.toLowerCase()]
    return Array.isArray(v) ? v.join(',') : v ?? '-'
  }
  const signals = [
    `status=${status}`,
    `server=${h('server')}`,
    `cf-ray=${h('cf-ray')}`,
    `cf-mitigated=${h('cf-mitigated')}`,
    `cf-cache-status=${h('cf-cache-status')}`,
    `via=${h('via')}`,
    `content-type=${h('content-type')}`,
    `retry-after=${h('retry-after')}`,
  ].join(' ')
  const snippet = body.toString('utf-8').slice(0, 300).replace(/\s+/g, ' ').trim()
  return `${signals} | body[0:300]=${snippet}`
}

/**
 * 抓一次 BGM 搜索 HTML。**不做应用层自动重试**(红线):失败一律抛到 UI,由用户点重试。
 * 唯一的代码层重试是 `withTransientRetry`(ECONNRESET 这类瞬时 socket 错误),用户无感。
 *
 * 限流页 body / HTTP 429 → `RateLimitError`(UI 倒计时);其余 4xx/5xx/网络异常 → 普通
 * Error,交给渲染层的 friendlyError 分类。
 */
export async function fetchHtmlWithDefenses(url: string): Promise<string> {
  return limiter.schedule(async () => {
    const t0 = Date.now()
    const r = await withTransientRetry(() => rawGet(url))
    if (r.status === 429) {
      throw new RateLimitError(30, 'BGM 返回 HTTP 429，触发限流')
    }
    if (r.status >= 400) {
      // 【临时诊断】抓 CDN/防护指纹 + body 片段：判断 502 是 CF 盾挑战还是纯网关错误。
      const diag = diagnoseFailure(r.status, r.headers, r.body)
      console.warn(`[bgm-search-diag] HTTP ${r.status} on ${url}\n  ${diag}`)
      throw new Error(`BGM 返回 HTTP ${r.status} ｜ ${diag}`)
    }
    const body = r.body.toString('utf-8')
    // BGM 搜索经常返 200 + 正文「您在 N 秒内只能进行一次搜索」,只能靠 body 认。
    const waitSec = detectLimit(body)
    if (waitSec != null) {
      throw new RateLimitError(waitSec, `BGM 触发限流，请等 ${waitSec} 秒后再试`)
    }
    // 页面有没有 /logout 是「服务端到底认不认这个登录态」的唯一真话:带了 cookie 也可能
    // 不认,那时仍走 ~16s 的匿名慢速通道。不记这行,登录提速有没有生效只能靠猜。
    logInfo(
      'bgm-search',
      `${Date.now() - t0}ms 带登录cookie=${getBgmCookie() ? '是' : '否'} 服务端登录态=${body.includes('/logout') ? '是' : '否'} ${url}`,
    )
    return body
  })
}

/**
 * 拉一页搜索结果。**失败一律 throw、不吞成 null** —— 吞掉的话 caller 分不清「网络问题」
 * 和「这页本来就是空的」,只能统一报「网络请求失败」误导用户。由 caller 决定
 * page=1 致命 / page≥2 跳过。
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

  let html: string
  try {
    // fetchHtmlWithDefenses 已经做了限流页检测 —— 拿到的 html 一定是干净的搜索结果页。
    html = await fetchHtmlWithDefenses(url)
  } catch (e) {
    if (page === 1) {
      if (e instanceof RateLimitError) {
        // 拿到了响应 = 连接通,清零超时计数,原样抛出显示它自己的真实倒计时。
        consecutiveSearchTimeouts = 0
      } else if (/\bHTTP \d{3}\b/.test((e as Error)?.message ?? '')) {
        // 拿到 HTTP 错误响应(如经 Cloudflare 的偶发 502)= 端点其实回包了,跟「丢包」
        // 两回事:不计入超时计数、不转成限流倒计时,让用户能立刻 Try again。
        consecutiveSearchTimeouts = 0
      } else {
        // 真·不回包:单次当网络抖,连撞阈值才判定疑似限流,给个信息性倒计时
        // (**不阻断**,用户点 Try again 仍会真的重新搜索)。
        consecutiveSearchTimeouts++
        if (consecutiveSearchTimeouts >= SEARCH_TIMEOUT_TRIP_THRESHOLD) {
          throw new RateLimitError(
            SEARCH_LIMIT_HINT_SEC,
            `BGM 搜索连续无响应，疑似被限流，建议等约 ${SEARCH_LIMIT_HINT_SEC} 秒再试`,
          )
        }
      }
    }
    throw e
  }

  if (page === 1) consecutiveSearchTimeouts = 0 // page 1 成功 → 清零超时计数
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

/** 归一化:转小写 + 去空白 + 去标点符号,让「Love Live!」「LoveLive!」「love-live」等价。
 *  中日文字符属 \p{L},不受影响。 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 把一页搜索 HTML 解析成结构化数组,每条多带一个 `visibleMatch`:主标题 / `<small.grey>`
 * 副标题里能不能(忽略空白标点地)命中关键词。
 *
 * BGM 服务端是宽匹配(搜「魔女的考验」会拉回所有含「魔」「女」的条目),而 HTML 里**只有**
 * 主标题 + 一个日/英副标题 —— BGM 真正按中文别名命中的那些别名根本不出现在页面上。
 * 所以分两段:这里先标出「有视觉证据」的命中(主路径);全都没命中时,searchBgm 再回退到
 * API 别名查询逐条验。
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
    // <small.grey> 通常是日/英原标题,一并纳入 visibleMatch,让搜日文名也能直接命中。
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
 * 从 BGM API 拉一个 subject 的「别名」。infobox 的 value 可能是 string 也可能是
 * `[{v}]` 数组(同字段多别名),两种都归一成 string[]。
 *
 * 失败一律返回空数组:别名回退是 best-effort 增强,**绝不**升级成致命错误。
 */
async function fetchAliases(subjectId: number): Promise<string[]> {
  if (!subjectId) return []
  let infobox: Array<{ key: string; value: unknown }>
  try {
    const data = await fetchBgmApiJson<Record<string, unknown>>(
      `https://api.bgm.tv/v0/subjects/${subjectId}`,
    )
    infobox = (data.infobox ?? []) as Array<{ key: string; value: unknown }>
  } catch {
    // API 失败就降级抓 HTML 拿同形 infobox。**任何失败都要降级、不能只认
    // RateLimitError** —— BGM 限流多半表现为超时,只认 429 的话按别名搜索在限流期间
    // 永远命中不了。HTML 也失败才静默跳过。
    try {
      const data = await fetchSubjectViaHtml(subjectId)
      infobox = data.infobox
    } catch {
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
 * 分页早停:连续这么多页「整页没有任何 visibleMatch」就不再翻。BGM 按相关度排序,真命中
 * 聚在前面,之后全是字符碎片噪声 —— 硬翻既没结果,每页还要在限流红线上等 ~2.5s
 * (搜「光之美少女」命中带 8 页、totalPages 却有 82,全抓 ≈ 3 分钟纯浪费)。
 * 阈值 2 容忍命中带中间偶发的一页空档。
 */
const EARLY_STOP_PAGES_WITHOUT_VISIBLE_MATCH = 2

/**
 * 别名回退的**唯一** per-search 限制器:连续 miss 这么多次就早停,每次 hit 重置计数
 * 从而容忍 hit/miss 交错、沿整条命中带扫到底。
 *
 * **别再加「最多查 N 条」的硬上限**:砍候选池 = 砍召回,头部一个热门噪声条目(搜
 * 「谭雅战记」时 BGM 把「罗小黑战记2」排第 1)就能把真命中挤出窗口。失控扫描由全局
 * 护栏兜底(L2 滚动窗口 + L3 熔断),不靠这里砍召回。
 */
const ALIAS_LOOKUP_MAX_CONSECUTIVE_MISSES = 3
/** 早停前至少要攒够这么多条 unmatched 候选,免得第 1 页结果太少时命中带还没扫完就停。 */
const ALIAS_LOOKUP_MIN_CANDIDATES = 4

/** BGM 有候选但本地过滤为零时，保留相关度最高的几条供用户辨认。 */
const ZERO_MATCH_FALLBACK_LIMIT = 3

// ── Public API ────────────────────────────────────────────────────────────────

/** 每抓完一页(含命中缓存)回调一次,供渲染层显示「第 X / Y 页」。`current` 从 1 起。 */
export type SearchProgressCallback = (current: number, total: number) => void

export async function searchBgm(
  keyword: string,
  update = false,
  onProgress?: SearchProgressCallback,
  cat: BgmSearchCat = 2,
): Promise<BgmSearchResult[]> {
  await initCache()

  // 第一页必须成功:原始错误直接抛上去,让 UI 的 friendlyError 分类成「限流」/「连不上」
  // /「服务器异常」,别collapse 成通用的「网络请求失败」。
  const html1 = await fetchPage(keyword, 1, update, cat)

  const totalPages = parseTotalPages(html1)
  onProgress?.(1, totalPages)

  // 标上页号:「近命中保留」只回收**触发页**上的 miss(见下方主循环)。
  const page1Items = parsePage(html1, keyword).map((it) => ({ ...it, page: 1 }))
  if (page1Items.length === 0) return []

  const allItems = [...page1Items]

  // 早停状态(见 EARLY_STOP_PAGES_WITHOUT_VISIBLE_MATCH)
  let visibleCount = page1Items.filter((x) => x.visibleMatch).length
  let consecutiveNoVisible = visibleCount > 0 ? 0 : 1

  for (let page = 2; page <= totalPages; page++) {
    // 限流必须中断整个搜索(继续抓只会加重惩罚);其他临时错误跳过本页继续 ——
    // 已经有 page1 的结果,不能因为 page 4 抖一下就把整个搜索废掉。
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

    // 放在 push 之后:本页结果一定先收进 allItems,再决定要不要翻下一页。
    const pageVisible = items.filter((x) => x.visibleMatch).length
    visibleCount += pageVisible
    consecutiveNoVisible = pageVisible > 0 ? 0 : consecutiveNoVisible + 1

    // 别名回退路径(visibleCount 全程为 0)要攒够候选才允许早停,否则没东西可查。
    const unmatchedCount = allItems.length - visibleCount
    if (
      consecutiveNoVisible >= EARLY_STOP_PAGES_WITHOUT_VISIBLE_MATCH &&
      (visibleCount > 0 || unmatchedCount >= ALIAS_LOOKUP_MIN_CANDIDATES)
    ) {
      break
    }
  }

  // 按 BGM 相关度顺序单遍处理,每条三选一:
  //   1. 标题 / 日文副标题命中 → 直接收(零 API),重置连续 miss
  //   2. 标题没命中 → 验别名;别名也没命中 = miss
  //   3. 连续 N 个 miss → 触发「近命中保留」并停止验别名(之后的可见命中仍照收)
  //
  // 「近命中保留」(用户拍板):用户常按俗称 / 系列名搜,想要的续作(搜「黑之契约者」
  // 想要「DARKER THAN BLACK –流星的双子–」)标题和别名可能都不含这个词、会被当 miss
  // 但它紧挨命中带、通常正是用户要的。所以早停时把**触发那一页**上已检查过的 miss 也
  // 一并返回;更早的页离命中带更远,不回收。`sawHit` 是锚点:本次确实命中过才回收
  // 免得「整页零命中」的搜索返回一整页纯噪声。
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
    // 早停后不再验别名,但循环继续,后面的可见命中照收。
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

  // BGM 有结果却被本地严格匹配全滤掉时不能误报「未找到」;真无结果已在上面提前返回。
  if (matched.length === 0) {
    matched.push(...allItems.slice(0, ZERO_MATCH_FALLBACK_LIMIT))
  }

  // 去重 + 按日期排序,最新的在最上面。
  const seen = new Set<string>()
  const deduped = matched.filter((x) => {
    if (seen.has(x.title)) return false
    seen.add(x.title)
    return true
  })
  deduped.sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime())

  return deduped.map(({ title, date, rate, link }) => ({ title, date, rate, link }))
}
