import * as cheerio from 'cheerio/slim'
import { HttpSession } from '../shared/http-session'
import { DESKTOP_USER_AGENT } from '../shared/download-types'
import { crawlAllPages } from '../shared/maccms-search-paginator'

const BASE_URL = 'https://dm.xifanacg.com'
const HEADERS = {
  'User-Agent': DESKTOP_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
}

export const xifanSession = new HttpSession('xifan', HEADERS)

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
 * 只扫 class 含 anthology 的选集区域:播放器的「上一集/下一集」按钮等导航链接
 * 也指向 watch/{id}/{src}/{ep}.html,落在全局扫会把集名污染成「下一集」。
 */
function parseEpLabels(html: string, animeId: string): Map<number, Map<number, string>> {
  const $ = cheerio.load(html)
  const bySource = new Map<number, Map<number, string>>()
  const hrefPat = new RegExp(`/watch/${animeId}/(\\d+)/(\\d+)\\.html$`)
  $('[class*="anthology"] a[href]').each((_, el) => {
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

/**
 * 回源解析某一集的真实 mp4 地址:拉该集播放页,读 player_aaaa.url。
 * 模板只能拼出数字文件名,OVA 这类特殊集(文件名是 OVA.mp4 等)拼出来必 404,
 * 只有播放页里才有真实地址。解析不出来返回 null,由调用方决定怎么报错。
 */
export async function resolveEpRealUrl(epPage: string, ep: number): Promise<string | null> {
  const res = await xifanSession.get(epPage.replace('{ep}', String(ep)))
  const data = parsePlayerData(res.body)
  if (!data?.url) return null
  return decodeURIComponent(data.url)
}

// ── captcha ────────────────────────────────────────────────────────────────────

export async function getCaptcha(): Promise<{ image_b64: string }> {
  const res = await xifanSession.get(`${BASE_URL}/verify/index.html?t=${Date.now()}`)
  xifanSession.save()
  return { image_b64: res.bodyBuffer.toString('base64') }
}

// ── verify ─────────────────────────────────────────────────────────────────────

export async function verifyCaptcha(code: string): Promise<{ success: boolean }> {
  const url = `${BASE_URL}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`
  const res = await xifanSession.get(url, {
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
  })
  xifanSession.save()
  const t = res.body
  const success = t.includes('"code":1') || t.includes('成功') || t.toLowerCase().includes('"msg":"ok"')
  return { success }
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
  const res = await xifanSession.get(url)
  xifanSession.save()

  if (needsCaptcha(res.body)) return { needs_captcha: true }

  // Sequential pagination via shared helper — follows `下一页` links with 1s delay.
  // The session cookie persists across page fetches so the captcha gate stays open.
  return crawlAllPages({
    firstHtml: res.body,
    baseUrl: BASE_URL,
    parsePage: parseSearchPage,
    fetchHtml: async (pageUrl) => {
      const r = await xifanSession.get(pageUrl)
      xifanSession.save()
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

async function fetchSourceEp1(animeId: string, sourceIdx: number): Promise<{ template: string | null; ep1: string; epPage: string; epLabels: string[] }> {
  const epPage = epPageTemplate(animeId, sourceIdx)
  try {
    const res = await xifanSession.get(epPage.replace('{ep}', '1'))
    const data = parsePlayerData(res.body)
    // 该源自己的播放页上它就是激活源,选集列表一定在,顺手把集名也解析出来
    const epLabels = labelsToArray(parseEpLabels(res.body, animeId).get(sourceIdx))
    if (!data) return { template: null, ep1: '', epPage, epLabels }
    const ep1Url = decodeURIComponent(data.url)
    return { template: buildTemplate(ep1Url), ep1: ep1Url, epPage, epLabels }
  } catch {
    return { template: null, ep1: '', epPage, epLabels: [] }
  }
}

export async function watch(watchUrl: string): Promise<XifanWatchInfo> {
  const res = await xifanSession.get(watchUrl)
  xifanSession.save()
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
  const sources: XifanSource[] = []
  // \u5F53\u524D\u9875\u53EF\u80FD\u5C31\u5E26\u7740\u6240\u6709\u6E90\u7684\u9009\u96C6\u5217\u8868(\u9690\u85CF tab),\u80FD\u62FF\u5230\u7684\u76F4\u63A5\u7528,\u62FF\u4E0D\u5230\u7684\u6E90
  // \u518D\u4ECE\u5B83\u81EA\u5DF1\u7684\u64AD\u653E\u9875(fetchSourceEp1 \u53CD\u6B63\u8981\u62C9)\u4E0A\u89E3\u6790\u3002
  const labelsBySource = parseEpLabels(html, animeId)

  for (let i = 0; i < sourceTags.length; i++) {
    const tag = sourceTags.eq(i)
    const badgeText = tag.find('span.badge').text()
    const iconText = tag.find('i').text()
    const name = tag.text().replace(badgeText, '').replace(iconText, '').replace(/\u00A0/g, ' ').trim()
    const idx = i + 1
    const pageLabels = labelsToArray(labelsBySource.get(idx))

    if (idx === 1) {
      sources.push({ idx: 1, name, template: buildTemplate(ep1Url), ep1: ep1Url, epPage: epPageTemplate(animeId, 1), epLabels: pageLabels })
    } else {
      const { template, ep1, epPage, epLabels } = await fetchSourceEp1(animeId, idx)
      sources.push({ idx, name, template, ep1: ep1, epPage, epLabels: pageLabels.length > 0 ? pageLabels : epLabels })
    }
  }

  return { title, id: animeId, total, sources }
}
