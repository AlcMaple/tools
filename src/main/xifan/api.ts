import * as cheerio from 'cheerio/slim'
import { HttpSession } from '../shared/http-session'
import { DESKTOP_USER_AGENT } from '../shared/download-types'
import { JsonStore } from '../shared/json-store'
import { crawlAllPages } from '../shared/maccms-search-paginator'
import { assertScrapePageOk } from '../shared/scrape-guard'
import { RateLimiter } from '../shared/rate-limit'
import { logInfo } from '../shared/logger'
import {
  getXifanBrowserSession,
  isXifanPageUrl,
  loadXifanBrowserPage,
  requestXifanBrowser,
  XIFAN_ORIGIN,
} from './browser-challenge'

// 站点旧域 dm.xifanacg.com 现 301 跳到 anime.xifanacg.com，直接用新域省掉
// 每次跨域跳转。后台页面仍允许该子域，旧下载任务里残留的播放页链接可继续跟随 301。
const BASE_URL = XIFAN_ORIGIN
const HEADERS = {
  'User-Agent': DESKTOP_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
}

// 旧版登录态原本落在这个扁平 cookie 文件。首次用浏览器分区前会单向迁入；
// 此后所有稀饭操作共用同一个 Chromium 会话，避免验证码、登录、页面各自一罐。
export const xifanSession = new HttpSession('xifan', HEADERS)
let legacyCookiesImported = false
let legacyCookieImport: Promise<void> | null = null

// Xifan 的 MP4 地址不是媒体内容缓存：这里只记「某播放页最终给出的地址」，让同一集
// 在 24 小时内重新点开时不用再进站点页面。上游随时可提前让链接失效，因此播放器
// 一旦报错会强制回源刷新该项；不额外 probe，避免为了判断过期反而多打一笔请求。
interface XifanUrlCacheEntry {
  url: string
  resolvedAt: number
}

type XifanUrlCache = Record<string, XifanUrlCacheEntry>

const XIFAN_URL_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const XIFAN_URL_CACHE_MAX_ENTRIES = 500
const xifanUrlInflight = new Map<string, Promise<string | null>>()

function isHttpMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function isFreshXifanUrl(entry: XifanUrlCacheEntry, now = Date.now()): boolean {
  return entry.resolvedAt <= now && now - entry.resolvedAt < XIFAN_URL_CACHE_TTL_MS
}

function normalizeXifanUrlCache(raw: unknown): XifanUrlCache {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const now = Date.now()
  const normalized: XifanUrlCache = {}
  for (const [pageUrl, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Partial<XifanUrlCacheEntry>
    if (
      typeof entry.url === 'string' &&
      typeof entry.resolvedAt === 'number' &&
      Number.isFinite(entry.resolvedAt) &&
      isHttpMediaUrl(entry.url) &&
      isFreshXifanUrl({ url: entry.url, resolvedAt: entry.resolvedAt }, now)
    ) {
      normalized[pageUrl] = { url: entry.url, resolvedAt: entry.resolvedAt }
    }
  }
  return normalized
}

const xifanUrlCacheStore = new JsonStore<XifanUrlCache>(
  'xifan-url-cache.json',
  normalizeXifanUrlCache,
)

// watch() 本身就是「当前源第 1 集」的播放页：一次请求同时给出总集数、各源名称/
// epLabels，以及当前源的地址模板——后续每一集地址都靠模板纯计算（见
// resolveEpPlaybackUrl），不再碰网络。换句话说，进播放器时唯一真正打到稀饭
// 服务器的就是这一次。已完结番（追番记录填过总集数）结构不会再变，允许调用方
// 传 preferCache 跳过这次请求，直接吃缓存；连载番不传，永远按最新结果覆盖缓存。
interface XifanWatchCacheEntry {
  info: XifanWatchInfo
  savedAt: number
}

type XifanWatchCache = Record<string, XifanWatchCacheEntry>

const XIFAN_WATCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const XIFAN_WATCH_CACHE_MAX_ENTRIES = 500

function isFreshXifanWatchEntry(entry: XifanWatchCacheEntry, now = Date.now()): boolean {
  return entry.savedAt <= now && now - entry.savedAt < XIFAN_WATCH_CACHE_TTL_MS
}

function isXifanSource(value: unknown): value is XifanSource {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<XifanSource>
  return (
    typeof s.idx === 'number' &&
    typeof s.name === 'string' &&
    (s.template === null || typeof s.template === 'string') &&
    typeof s.ep1 === 'string' &&
    typeof s.epPage === 'string' &&
    Array.isArray(s.epLabels) &&
    s.epLabels.every((l) => typeof l === 'string')
  )
}

function isXifanWatchInfo(value: unknown): value is XifanWatchInfo {
  if (!value || typeof value !== 'object') return false
  const info = value as Partial<XifanWatchInfo>
  return (
    typeof info.title === 'string' &&
    typeof info.id === 'string' &&
    typeof info.total === 'number' &&
    Array.isArray(info.sources) &&
    info.sources.every(isXifanSource)
  )
}

function normalizeXifanWatchCache(raw: unknown): XifanWatchCache {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const now = Date.now()
  const normalized: XifanWatchCache = {}
  for (const [watchUrl, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Partial<XifanWatchCacheEntry>
    if (
      typeof entry.savedAt === 'number' &&
      Number.isFinite(entry.savedAt) &&
      isXifanWatchInfo(entry.info) &&
      isFreshXifanWatchEntry({ info: entry.info, savedAt: entry.savedAt }, now)
    ) {
      normalized[watchUrl] = { info: entry.info, savedAt: entry.savedAt }
    }
  }
  return normalized
}

const xifanWatchCacheStore = new JsonStore<XifanWatchCache>(
  'xifan-watch-cache.json',
  normalizeXifanWatchCache,
)

function rememberXifanWatch(watchUrl: string, info: XifanWatchInfo): void {
  xifanWatchCacheStore.update((cache) => {
    const now = Date.now()
    for (const [key, entry] of Object.entries(cache)) {
      if (!isFreshXifanWatchEntry(entry, now)) delete cache[key]
    }
    delete cache[watchUrl]
    const oldestFirst = Object.entries(cache)
      .sort(([, a], [, b]) => a.savedAt - b.savedAt)
    const removeCount = Math.max(0, oldestFirst.length - (XIFAN_WATCH_CACHE_MAX_ENTRIES - 1))
    for (const [key] of oldestFirst.slice(0, removeCount)) delete cache[key]
    cache[watchUrl] = { info, savedAt: now }
  })
}

// 所有「真的要导航到稀饭 HTML 页」的操作共用这一个节流器。后台挑战页的 250ms
// 轮询只读 DOM，不经过这里；只有缓存未命中、用户确实需要新页面时才占一个名额。
const xifanPageLimiter = new RateLimiter({
  minGapMs: 400,
  jitterMs: 200,
  name: 'xifan-page',
})

function rememberXifanUrl(pageUrl: string, url: string): void {
  xifanUrlCacheStore.update((cache) => {
    const now = Date.now()
    for (const [key, entry] of Object.entries(cache)) {
      if (!isFreshXifanUrl(entry, now)) delete cache[key]
    }
    delete cache[pageUrl]
    const oldestFirst = Object.entries(cache)
      .sort(([, a], [, b]) => a.resolvedAt - b.resolvedAt)
    const removeCount = Math.max(0, oldestFirst.length - (XIFAN_URL_CACHE_MAX_ENTRIES - 1))
    for (const [key] of oldestFirst.slice(0, removeCount)) delete cache[key]
    cache[pageUrl] = { url, resolvedAt: now }
  })
}

function forgetXifanUrl(pageUrl: string): void {
  xifanUrlCacheStore.update((cache) => {
    delete cache[pageUrl]
  })
}

async function prepareXifanBrowserCookies(): Promise<void> {
  if (legacyCookiesImported) return
  if (!legacyCookieImport) {
    legacyCookieImport = (async () => {
      const part = getXifanBrowserSession()
      const existing = await part.cookies.get({ url: BASE_URL })
      const existingNames = new Set(existing.map((cookie) => cookie.name))
      await Promise.all(xifanSession.getCookieEntries()
        .filter(({ name }) => !existingNames.has(name))
        .map(({ name, value }) => part.cookies.set({ url: BASE_URL, name, value })))
      legacyCookiesImported = true
    })()
  }
  try {
    await legacyCookieImport
  } catch (err) {
    legacyCookieImport = null
    throw err
  }
}

/** 浏览器登录/验证码更新 cookie 后同步回旧文件，保留升级前的跨重启登录态。 */
async function syncXifanBrowserCookies(): Promise<void> {
  const part = getXifanBrowserSession()
  const cookies = await part.cookies.get({ url: BASE_URL })
  xifanSession.replaceCookies(cookies.map(({ name, value }) => ({ name, value })))
  xifanSession.save()
  await part.cookies.flushStore()
}

async function requestXifanService(
  url: string,
  options: Parameters<typeof requestXifanBrowser>[1] = {},
) {
  await prepareXifanBrowserCookies()
  return requestXifanBrowser(url, options)
}

function assertXifanServiceResponse(status: number, body: Buffer): void {
  assertScrapePageOk(status, body.toString('utf-8'), '稀饭')
}

function responseHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}
/**
 * 稀饭只读页面统一入口。
 *
 * 新 UAM 会给 HTTP 客户端返回 200 + Checking your Browser HTML。所有可解析的
 * 稀饭 HTML 页面统一走持久 Chromium 分区：检查在不可见 WebContents 中完成，
 * 正常页再串行读取 DOM。这样不会用主进程 HTTP 栈在验证后补打一遍、触发异常会话。
 */
async function getXifanPage(url: string) {
  if (!isXifanPageUrl(url)) throw new Error('稀饭页面地址无效')
  await prepareXifanBrowserCookies()
  const page = await xifanPageLimiter.schedule(() => loadXifanBrowserPage(url))
  const res = {
    status: 200,
    body: page.html,
    bodyBuffer: Buffer.from(page.html),
  }
  assertScrapePageOk(res.status, res.body, '稀饭')
  return res
}

export interface XifanSearchResult {
  title: string
  cover: string
  episode: string
  year: string
  area: string
  watch_url: string
  detail_url: string
}

export interface XifanSource {
  idx: number
  name: string
  template: string | null
  ep1: string
  /** 该源播放页 URL 模板({ep} 占位)。模板拼出的链接 404 时(如 OVA 集)回源解析真实地址用。 */
  epPage: string
  /** 站点标注的每集名称(下标 i = 第 i+1 集),如「第01集」「OVA」。解析不到时为空数组。 */
  epLabels: string[]
}

export interface XifanWatchInfo {
  title: string
  id: string
  total: number
  sources: XifanSource[]
}

function needsCaptcha(html: string): boolean {
  return html.includes('name="verify"') || html.includes('ds-verify-img')
}

function buildTemplate(ep1Url: string): string | null {
  // 用第 1 集 URL 里集数的「原始写法」决定补零宽度,绝不能一律补成两位:
  // 多数源是 .../01.mp4(补零两位),但有的源是 .../1.mp4(不补零)。写死
  // 成 {:02d} 会把后者的第 4 集拼成 04.mp4 → 服务器 404(见 docs 回归用例)。
  const m = ep1Url.match(/(.*?)(\d+)([^./\d]*\.[^./]+$)/)
  if (!m) return null
  const [, head, digits, tail] = m
  // 有前导零(如 01 / 001)才保留其位宽补零,否则用 {:d} 不补零(1 → 1,10 → 10)。
  const token = digits.length > 1 && digits.startsWith('0') ? `{:0${digits.length}d}` : '{:d}'
  return `${head}${token}${tail}`
}

function epPageTemplate(animeId: string, sourceIdx: number): string {
  return `${BASE_URL}/watch/${animeId}/${sourceIdx}/{ep}.html`
}

/**
 * 从播放页 HTML 的选集列表里解析「每集名称」,按源分组(集序号 → 站点标注的集名)。
 * 站点对特殊集会直接标注真名(如最后一集是「OVA」而不是「第13集」),这是同一
 * 页面里现成的数据,不用额外请求。
 *
 * 只扫 class 含 anthology-list 的选集列表区域(实测页面结构:ul.anthology-list-play)。
 * 不能放宽到 anthology:anthology-header 里的「下集」导航按钮也指向
 * watch/{id}/{src}/{ep}.html 且出现在列表之前,会把对应集的集名污染成「下集」。
 */
function parseEpLabels(html: string, animeId: string): Map<number, Map<number, string>> {
  const $ = cheerio.load(html)
  const bySource = new Map<number, Map<number, string>>()
  const hrefPat = new RegExp(`/watch/${animeId}/(\\d+)/(\\d+)\\.html$`)
  $('[class*="anthology-list"] a[href]').each((_, el) => {
    const a = $(el)
    // 源切换 tab(vod-playerUrl / 带集数 badge)不是集数项,跳过
    if (a.hasClass('vod-playerUrl') || a.find('span.badge').length) return
    const m = (a.attr('href') ?? '').match(hrefPat)
    if (!m) return
    const src = parseInt(m[1], 10)
    const ep = parseInt(m[2], 10)
    // 站点会在集名里夹字体图标(PUA 码位),剥掉再存
    const label = a.text().replace(/[\u{E000}-\u{F8FF}]/gu, '').replace(/ /g, ' ').trim()
    if (!label || label.length > 30) return
    let eps = bySource.get(src)
    if (!eps) { eps = new Map(); bySource.set(src, eps) }
    if (!eps.has(ep)) eps.set(ep, label)
  })
  return bySource
}

/** 集名 Map → 按序号排好的数组(下标 i = 第 i+1 集),缺口用集号补。解析不到 → []。 */
function labelsToArray(m: Map<number, string> | undefined): string[] {
  if (!m || m.size === 0) return []
  const maxEp = Math.max(...m.keys())
  return Array.from({ length: maxEp }, (_, i) => m.get(i + 1) ?? String(i + 1))
}

function xifanEpisodePageUrl(epPage: string, ep: number): string {
  if (!Number.isSafeInteger(ep) || ep < 1) throw new Error('稀饭集数无效')
  const pageUrl = epPage.replace('{ep}', String(ep))
  if (!isXifanPageUrl(pageUrl)) throw new Error('稀饭播放页地址无效')
  return pageUrl
}

/** 与下载器 formatEpUrl 保持同一补零规则。 */
function xifanUrlFromTemplate(template: string, ep: number): string {
  return template.replace(/\{:0?(\d*)d\}/, (_, width: string) =>
    String(ep).padStart(width ? parseInt(width, 10) : 0, '0'))
}

function decodeXifanPlayerUrl(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 取得一集要交给播放器的最终地址。缓存 key 是具体播放页而非标题，避免同名番 /
 * 不同线路串用；缓存命中完全不加载站点页面。`forceRefresh` 仅供 <video> 已经
 * 报错后的单次兜底使用：主动丢掉旧地址并回源读取 player_aaaa.url，不探活、不重试。
 */
export async function resolveEpPlaybackUrl(
  template: string | null,
  epPage: string,
  ep: number,
  forceRefresh = false,
): Promise<string | null> {
  const pageUrl = xifanEpisodePageUrl(epPage, ep)
  if (!forceRefresh) {
    const cached = (await xifanUrlCacheStore.read())[pageUrl]
    if (cached && isFreshXifanUrl(cached)) return cached.url
  }

  const pending = xifanUrlInflight.get(pageUrl)
  if (pending) return pending
  if (forceRefresh) forgetXifanUrl(pageUrl)

  const task = (async (): Promise<string | null> => {
    let url: string | null = null
    if (template && !forceRefresh) {
      // 常规集可以从第 1 集模板纯计算出地址，不为「确认它还有效」再打一笔站点请求。
      const templated = xifanUrlFromTemplate(template, ep)
      if (!isHttpMediaUrl(templated)) throw new Error('稀饭播放地址格式无效')
      url = templated
      logInfo('xifan-resolve', `第 ${ep} 集地址由模板计算得到（零请求）：${url}`)
    } else {
      // 无模板的特殊集，或已有媒体错误的旧地址，才真正回源读取该集页面。
      logInfo('xifan-resolve', `第 ${ep} 集${forceRefresh ? '强制刷新' : '无模板'}，回源读取：${pageUrl}`)
      const res = await getXifanPage(pageUrl)
      const data = parsePlayerData(res.body)
      if (!data?.url) return null
      const resolved = decodeXifanPlayerUrl(data.url)
      if (!isHttpMediaUrl(resolved)) throw new Error('稀饭播放页未返回有效视频地址')
      url = resolved
      logInfo('xifan-resolve', `第 ${ep} 集拿到地址：${url}`)
    }
    rememberXifanUrl(pageUrl, url)
    return url
  })()
  xifanUrlInflight.set(pageUrl, task)
  try {
    return await task
  } finally {
    xifanUrlInflight.delete(pageUrl)
  }
}

/** 下载器也走同一份 24h 地址缓存；它没有模板时始终由播放页给出真实地址。 */
export async function resolveEpRealUrl(epPage: string, ep: number): Promise<string | null> {
  return resolveEpPlaybackUrl(null, epPage, ep)
}

// ── captcha ────────────────────────────────────────────────────────────────────

export async function getCaptcha(): Promise<{ image_b64: string }> {
  const res = await requestXifanService(`${BASE_URL}/verify/index.html?t=${Date.now()}`, {
    headers: { Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
  })
  assertXifanServiceResponse(res.status, res.body)
  if (!responseHeader(res.headers, 'content-type').toLowerCase().startsWith('image/')) {
    throw new Error('稀饭验证码图片加载失败：站点没有返回图片')
  }
  await syncXifanBrowserCookies()
  return { image_b64: res.body.toString('base64') }
}

// ── verify ─────────────────────────────────────────────────────────────────────

export async function verifyCaptcha(code: string): Promise<{ success: boolean }> {
  const url = `${BASE_URL}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`
  const res = await requestXifanService(url, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  })
  assertXifanServiceResponse(res.status, res.body)
  await syncXifanBrowserCookies()
  const t = res.body.toString('utf-8')
  const success = t.includes('"code":1') || t.includes('成功') || t.toLowerCase().includes('"msg":"ok"')
  return { success }
}

// ── 账号登录 ───────────────────────────────────────────────────────────────────
// 登录、验证码和页面请求统一由同一个 Chromium 分区处理。旧 cookie 文件只作
// 升级迁移与跨重启兼容；渲染进程始终只拿登录布尔值，不接触 cookie 明文。

export interface XifanAuthStatus {
  loggedIn: boolean
}

/** 登录态:浏览器分区里有没有非空 user_id(退出/从未登录时该 cookie 不存在)。 */
export async function getXifanAuthStatus(): Promise<XifanAuthStatus> {
  await prepareXifanBrowserCookies()
  const cookies = await getXifanBrowserSession().cookies.get({ url: BASE_URL, name: 'user_id' })
  const uid = cookies.find((cookie) => cookie.value && cookie.value !== '0')?.value
  return { loggedIn: !!uid }
}

interface XifanAjaxResult {
  code?: number
  msg?: string
}

function parseAjaxResult(body: string): XifanAjaxResult {
  try {
    return JSON.parse(body) as XifanAjaxResult
  } catch {
    return {}
  }
}

/** 用户名/密码/验证码登录。成功后 cookie 落地,getXifanAuthStatus() 即反映已登录。 */
export async function login(
  username: string,
  password: string,
  verify: string,
): Promise<{ success: boolean; message: string }> {
  const body = new URLSearchParams({ user_name: username, user_pwd: password, verify }).toString()
  const res = await requestXifanService(`${BASE_URL}/index.php/user/login`, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  })
  assertXifanServiceResponse(res.status, res.body)
  await syncXifanBrowserCookies()
  const { code, msg } = parseAjaxResult(res.body.toString('utf-8'))
  return { success: Number(code) === 1, message: msg ?? '登录失败' }
}

export async function logout(): Promise<XifanAuthStatus> {
  const res = await requestXifanService(`${BASE_URL}/index.php/user/logout`, {
    method: 'POST',
    body: '',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  })
  assertXifanServiceResponse(res.status, res.body)
  await syncXifanBrowserCookies()
  void parseAjaxResult(res.body.toString('utf-8')) // 退出接口偶尔在 cookie 已失效时也回错误 msg,不影响本地状态判断
  return getXifanAuthStatus()
}

// ── search ─────────────────────────────────────────────────────────────────────

function parseSearchPage(html: string): XifanSearchResult[] {
  const $ = cheerio.load(html)
  const results: XifanSearchResult[] = []

  $('div.row.mask2 div.vod-detail.search-list').each((_, el) => {
    const titleTag = $(el).find('h3.slide-info-title')
    const linkTag = titleTag.parent('a')
    const title = titleTag.text().trim()
    const href = linkTag.attr('href') ?? ''
    const detailUrl = href ? `${BASE_URL}${href}` : ''

    const playHref = $(el).find('div.vod-detail-bnt a.button').attr('href') ?? ''
    const watchUrl = playHref ? `${BASE_URL}${playHref}` : ''

    const cover = $(el).find('div.detail-pic img').attr('data-src') ?? ''
    const remarks: string[] = []
    $(el).find('span.slide-info-remarks').each((_, r) => { remarks.push($(r).text().trim()) })

    if (title) {
      results.push({
        title,
        cover,
        episode: remarks[0] ?? '',
        year: remarks[1] ?? '',
        area: remarks[2] ?? '',
        watch_url: watchUrl,
        detail_url: detailUrl,
      })
    }
  })

  return results
}

export async function search(keyword: string): Promise<XifanSearchResult[] | { needs_captcha: true }> {
  const url = `${BASE_URL}/search.html?wd=${encodeURIComponent(keyword)}`
  logInfo('xifan-search', `搜索请求：${url}`)
  const res = await getXifanPage(url)

  if (needsCaptcha(res.body)) {
    logInfo('xifan-search', `站点要求输入验证码：${url}`)
    return { needs_captcha: true }
  }

  // Sequential pagination via shared helper — follows `下一页` links with 1s delay.
  // Chromium 分区会在分页之间保留会话，避免挑战完成后又回退到主进程 HTTP 栈。
  return crawlAllPages({
    firstHtml: res.body,
    baseUrl: BASE_URL,
    parsePage: parseSearchPage,
    fetchHtml: async (pageUrl) => {
      const r = await getXifanPage(pageUrl)
      if (needsCaptcha(r.body)) throw new Error('captcha re-appeared mid-pagination')
      return r.body
    },
  })
}

// ── watch ──────────────────────────────────────────────────────────────────────

interface PlayerData {
  url: string
  from: string
  id: string
  vod_data?: { vod_name?: string }
}

function parsePlayerData(html: string): PlayerData | null {
  // Try compact JSON first
  const m1 = html.match(/var player_aaaa\s*=\s*(\{.*?\})<\/script>/)
  if (m1) {
    try { return JSON.parse(m1[1]) as PlayerData } catch { /* fall through */ }
  }
  // Fall back to block parsing
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

  return { url: getStr('url'), from: getStr('from'), id: getStr('id'), vod_data: { vod_name: vodName } }
}

// resolveAllSources 会把多条线路的播放页并发拉齐。旧代码是 for 里逐条 await,
// 顺序性无意中给了请求间隔;改并发后这层保护消失,同域一次打 3~6 个是明显的
// bot-like 突发。这里补一条节流:间隔只压到 150~400ms(远小于单条请求本身的
// 几百 ms),所以请求仍然是重叠的、面板不会退回「一条等一条」,但发起时刻被
// 错开,不再是同一瞬间的齐发。不设滚动窗口配额——面板是用户手点触发、低频。
const sourceLimiter = new RateLimiter({
  minGapMs: 150,
  jitterMs: 250,
  name: 'xifan-source',
})

/**
 * 拉某条线路自己的播放页,解出 template/ep1/集名。
 *
 * 错误处理刻意分两类(旧代码一个 `catch {}` 全吞掉,导致被限流 / CF 拦截时
 * UI 显示成「这条线路没源」,用户只会去换线路反复点、把限流踩得更深):
 * - **解析不出播放数据**(站点结构变了 / 该源确实是空的)→ `template: null`
 *   返回,只损失这一条线路,其余照常展示。
 * - **HTTP 非 2xx / CF 拦截**(限流、风控、故障)→ `assertScrapePageOk` 抛出
 *   带原因的错误,一路冒泡到 UI 走 friendlyError 的限流提示 + 倒计时重试。
 */
async function fetchSourceEp1(animeId: string, sourceIdx: number): Promise<{ template: string | null; ep1: string; epPage: string; epLabels: string[] }> {
  const epPage = epPageTemplate(animeId, sourceIdx)
  const res = await sourceLimiter.schedule(() => getXifanPage(epPage.replace('{ep}', '1')))
  const data = parsePlayerData(res.body)
  // 该源自己的播放页上它就是激活源,选集列表一定在,顺手把集名也解析出来
  const epLabels = labelsToArray(parseEpLabels(res.body, animeId).get(sourceIdx))
  if (!data) return { template: null, ep1: '', epPage, epLabels }
  const ep1Url = decodeURIComponent(data.url)
  return { template: buildTemplate(ep1Url), ep1: ep1Url, epPage, epLabels }
}

export async function watch(watchUrl: string, preferCache = false): Promise<XifanWatchInfo> {
  if (preferCache) {
    const cached = (await xifanWatchCacheStore.read())[watchUrl]
    if (cached && isFreshXifanWatchEntry(cached)) {
      logInfo('xifan-watch', `命中本地 watch 缓存,跳过请求：${watchUrl}`)
      return cached.info
    }
  }
  logInfo('xifan-watch', `请求 watch 页：${watchUrl}`)
  const res = await getXifanPage(watchUrl)
  const html = res.body

  const data = parsePlayerData(html)
  if (!data) throw new Error('Failed to parse player data')

  const animeId = data.id
  const title = data.vod_data?.vod_name ?? ''
  const ep1Url = decodeURIComponent(data.url)
  const currentFrom = data.from

  const $ = cheerio.load(html)
  let total = 1
  const activeTag = $(`a[data-form="${currentFrom}"]`)
  if (activeTag.length) {
    const badge = activeTag.find('span.badge')
    const n = parseInt(badge.text())
    if (!isNaN(n)) total = n
  }

  const sourceTags = $('div.anthology-tab.nav-swiper a.vod-playerUrl')
  // 当前页可能就带着所有源的选集列表（隐藏 tab），能拿到的直接用；拿不到的源
  // 再从它自己的播放页（fetchSourceEp1）上解析。
  const labelsBySource = parseEpLabels(html, animeId)

  const sourceMeta = Array.from({ length: sourceTags.length }, (_, i) => {
    const tag = sourceTags.eq(i)
    const badgeText = tag.find('span.badge').text()
    const iconText = tag.find('i').text()
    const name = tag.text().replace(badgeText, '').replace(iconText, '').replace(/\u00A0/g, ' ').trim()
    const idx = i + 1
    return { idx, name, pageLabels: labelsToArray(labelsBySource.get(idx)) }
  })

  // 除当前激活源（idx===1，数据已在本页拿到）外，其余每条源都要各回一次它自己
  // 的播放页（fetchSourceEp1）才能拿到 template。这里故意**不**在 watch() 里
  // 抢先把它们全解析出来——网站本身也只在用户真的点某条线路时才去加载它，
  // 这里跟着做同样的事：只把 name/epPage/pageLabels（这些解析本页 HTML 就有，
  // 零请求）填进占位，template 留空。播放器切到某条线路、要播某一集时，
  // resolveStream()（OnlinePlayer.tsx）已有的兜底路径会按需去解那一集的直链，
  // 不需要的线路永远不会产生额外请求。下载配置面板要一次性展示全部线路，
  // 那边改成调 resolveAllSources() 主动补全（见下）。
  const sources: XifanSource[] = sourceMeta.map(({ idx, name, pageLabels }) => {
    if (idx === 1) {
      return { idx: 1, name, template: buildTemplate(ep1Url), ep1: ep1Url, epPage: epPageTemplate(animeId, 1), epLabels: pageLabels }
    }
    return { idx, name, template: null, ep1: '', epPage: epPageTemplate(animeId, idx), epLabels: pageLabels }
  })

  const info: XifanWatchInfo = { title, id: animeId, total, sources }
  logInfo('xifan-watch', `拿到集数信息：《${title}》总集数=${total}，线路数=${sources.length}`)
  rememberXifanWatch(watchUrl, info)
  return info
}

/**
 * 补全 watch() 里留空的源（template === null）。下载配置面板要一次性展示
 * 全部线路供用户选，在这里主动并发拉齐；播放器不需要——它按需惰性解析
 * （见 resolveStream 的兜底路径）。已解析过的源原样透传，不重复请求。
 *
 * 并发但受 `sourceLimiter` 节流（发起时刻错开，不是齐发）。任一条遇到限流 /
 * CF 拦截会让整个 Promise.all reject —— 这是故意的：那种情况下继续展示剩下
 * 几条只会让用户以为「这几条没源」，不如把真实原因抛到 UI 让他等倒计时。
 */
export async function resolveAllSources(animeId: string, sources: XifanSource[]): Promise<XifanSource[]> {
  return Promise.all(
    sources.map(async (s) => {
      if (s.template) return s
      const { template, ep1, epPage, epLabels } = await fetchSourceEp1(animeId, s.idx)
      return { ...s, template, ep1, epPage, epLabels: s.epLabels.length > 0 ? s.epLabels : epLabels }
    }),
  )
}
