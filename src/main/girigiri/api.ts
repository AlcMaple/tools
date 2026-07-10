import * as cheerio from 'cheerio/slim'
import { HttpSession } from '../shared/http-session'
import { DESKTOP_USER_AGENT } from '../shared/download-types'
import { crawlAllPages } from '../shared/maccms-search-paginator'
import { assertScrapePageOk } from '../shared/scrape-guard'

// 2026-07-10:站点主域从 bgm.girigirilove.com 换到 ani.girigirilove.com,旧域名
// 现在 301 过来。改域名的同时也把 net-request 的 manual 重定向修了(旧代码碰到
// 3xx 必抛 "Redirect was cancelled"),所以就算再换域名也只是多跟一跳,不会整源挂掉。
export const BASE_DOMAIN = 'https://ani.girigirilove.com'
const HEADERS = {
  'User-Agent': DESKTOP_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_DOMAIN}/`,
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'max-age=0',
}

export const giriSession = new HttpSession('girigiri', HEADERS)

export interface GiriSearchResult {
  title: string
  cover: string
  year: string
  region: string
  play_url: string
}

export interface GiriEpisode {
  idx: number
  name: string
  url: string
}

export interface GiriSource {
  name: string
  episodes: GiriEpisode[]
}

export interface GiriWatchInfo {
  title: string
  sources: GiriSource[]
  episodes: GiriEpisode[]  // = sources[0].episodes
}

function needsCaptcha(html: string): boolean {
  const indicators = ['name="verify"', 'ds-verify-img', 'verify/index.html', 'class="verify-', '滑动验证', '请完成验证']
  return indicators.some((s) => html.includes(s))
}

function resolveUrl(href: string): string {
  try { return new URL(href, BASE_DOMAIN).href } catch { return href }
}

// ── captcha ────────────────────────────────────────────────────────────────────

export async function getCaptcha(): Promise<{ image_b64: string }> {
  const url = `${BASE_DOMAIN}/verify/index.html?t=${Date.now()}`
  const res = await giriSession.get(url)
  giriSession.save()
  return { image_b64: res.bodyBuffer.toString('base64') }
}

// ── verify ─────────────────────────────────────────────────────────────────────

export async function verifyCaptcha(code: string): Promise<{ success: boolean }> {
  const url = `${BASE_DOMAIN}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`
  const res = await giriSession.get(url, {
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  })
  giriSession.save()
  const t = res.body
  const success = ['"code":1', '成功', '"msg":"ok"', '验证通过', '验证成功'].some((s) => t.includes(s))
  return { success }
}

// ── search ─────────────────────────────────────────────────────────────────────

async function parseSearchPage(html: string): Promise<GiriSearchResult[]> {
  const $ = cheerio.load(html)
  const results: GiriSearchResult[] = []
  const seen = new Set<string>()

  let items = $('div[class*="vod-item"][class*="col"], div[class^="g-movie-item"], li[class*="vod-list-item"]')
  console.log(`[girigiri:search] primary selector matched ${items.length} items`)
  if (!items.length) {
    items = $('div[class*="mask2"] > div[class*="vod-detail"]')
    console.log(`[girigiri:search] mask2 fallback matched ${items.length} items`)
  }

  const elements = items.toArray();
  for (const el of elements) {
    const link = $(el).find('a[href]').first()
    if (!link.length) continue
    const href = link.attr('href') ?? ''
    const playUrl = resolveUrl(href)
    if (seen.has(playUrl)) continue
    seen.add(playUrl)

    const titleTag = link.find('h3').first() || link.find('span').first() || link
    const title = titleTag.text().trim() || link.text().trim()
    if (!title) continue

    let img = $(el).find('img').first();
    if (!img.length) {
      img = $(el).parent().find('img').first();
    }
    if (!img.length) {
      img = link.closest('.flex, .vod-item, .g-movie-item, li').find('img').first();
    }

    const rawCover = img.attr('data-src') ?? img.attr('data-original') ?? img.attr('src') ?? '';
    const coverUrl = rawCover ? resolveUrl(rawCover) : '';

    let finalCover = '';
    if (coverUrl) {
      try {
        const imgRes = await fetch(coverUrl, {
          headers: {
            'Referer': BASE_DOMAIN,
            'User-Agent': DESKTOP_USER_AGENT,
          }
        });
        const arrayBuffer = await imgRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > 0) {
          finalCover = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        } else {
          finalCover = coverUrl;
        }
      } catch (err) {
        console.warn(`[girigiri:search]   failed to download cover for "${title}":`, err);
        finalCover = coverUrl;
      }
    } else {
      console.warn(`[girigiri:search]   no cover URL found in DOM for "${title}"`);
    }

    const infoText = $(el).find('div[class*="info"], span[class*="desc"], div[class*="meta"], p[class*="detail"]').text()
    const yearM = infoText.match(/(\d{4})/)
    const regionM = infoText.match(/(日本|中国|美国|韩国|国产|日漫|大陆)/)

    results.push({
      title,
      cover: finalCover,
      year: yearM ? yearM[1] : '',
      region: regionM ? regionM[1] : '',
      play_url: playUrl,
    })
  }

  // Fallback: scan for /watch/ or /GV links when primary selectors return nothing.
  if (!results.length) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? ''
      if (href.includes('/watch/') || href.includes('/GV')) {
        const url2 = resolveUrl(href)
        const title = $(el).text().trim()
        if (!seen.has(url2) && title) {
          seen.add(url2)
          results.push({ title, cover: '', year: '', region: '', play_url: url2 })
        }
      }
    })
  }

  return results
}

export async function search(keyword: string): Promise<GiriSearchResult[] | { needs_captcha: true }> {
  const url = `${BASE_DOMAIN}/search/-------------/?wd=${encodeURIComponent(keyword)}`
  const res = await giriSession.get(url)
  giriSession.save()

  // CF 拦截 / 非 2xx 先显式抛错,别让异常页被解析成「0 结果 → 搜索不到结果」。
  assertScrapePageOk(res.status, res.body, '旗木')

  if (needsCaptcha(res.body)) return { needs_captcha: true }

  // Sequential pagination via shared helper — follows `下一页` links with 1s delay.
  // Cookie-based session keeps the captcha gate open across pages.
  return crawlAllPages({
    firstHtml: res.body,
    baseUrl: BASE_DOMAIN,
    parsePage: parseSearchPage,
    fetchHtml: async (pageUrl) => {
      const r = await giriSession.get(pageUrl)
      giriSession.save()
      if (needsCaptcha(r.body)) throw new Error('captcha re-appeared mid-pagination')
      return r.body
    },
  })
}

// ── watch ──────────────────────────────────────────────────────────────────────

const DATA_FORM_MAP: Record<string, string> = { cht: '繁中', chs: '簡中' }

/**
 * 从播放页（如 /playGV26879-1-1/）提取片源名列表。
 *
 * 列表页（/GV26879/）的 tab 是由 Swiper JS 动态插入的，原始 HTML 里没有；
 * 但播放页是 PHP 服务端渲染的，包含所有片源 tab，因此可以从这里拿到名称。
 */
async function resolveSourceNamesFromPlayerPage(firstEpUrls: string[]): Promise<string[]> {
  if (!firstEpUrls.length) return []
  try {
    // 只需抓第一个片源的第一集，页面里会列出所有片源 tab
    const res = await giriSession.get(firstEpUrls[0])
    const $p = cheerio.load(res.body)
    const names: string[] = []

    $p('a.vod-playerUrl, a[data-form]').each((_, el) => {
      const dataForm = $p(el).attr('data-form') ?? ''
      const text = $p(el).clone().children('.badge').remove().end().text().trim()
      const name = DATA_FORM_MAP[dataForm] || text
      if (name && !names.includes(name)) names.push(name)
    })

    if (names.length) {
      console.log(`[girigiri:watch]   player-page source names: [${names.join(', ')}]`)
    } else {
      console.warn('[girigiri:watch]   player page also has tabs=0, source names unavailable')
    }
    return names
  } catch (err) {
    console.warn('[girigiri:watch]   failed to fetch player page for source names:', err)
    return []
  }
}

// ── 播放地址解析(在线播放用) ──────────────────────────────────────────────────
//
// 播放地址就写在播放页 HTML 的 `player_aaaa` 里(MacCMS 通用结构,与稀饭同源),
// **不需要**起隐藏窗口截流 —— 那条路要几秒起步、还只认 *.m3u8。
// `encrypt` 决定 url 的编码:0=明文 / 1=percent-encode / 2=base64 再 percent-encode。
//
// 实测(2026-07-10,见 DEVLOG):girigiri 的播放地址是**静态路径,无签名、无时效**
// (没有 auth_key / expires / token 之类查询串),分片只带 UA 就能匿名取。
// 另外**并非都是 m3u8** —— 部分老番线路直接给 .mp4(如 ana.girigirilove.top/…/01.mp4),
// 所以这里只负责给出地址,由调用方按后缀决定走 HLS 还是直接喂 <video>。
function extractPlayerUrl(html: string): string {
  const at = html.indexOf('player_aaaa=')
  if (at < 0) return ''
  const start = html.indexOf('{', at)
  if (start < 0) return ''

  // 括号配平取出 JSON。要跳过字符串内部的花括号(vod_actor 等字段是任意文本),
  // 否则一个混在名字里的 `{` 就能把边界找歪。
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) { end = i; break }
  }
  if (end < 0) return ''

  let data: { url?: string; encrypt?: number }
  try {
    data = JSON.parse(html.slice(start, end + 1))
  } catch {
    return ''
  }
  const raw = data.url ?? ''
  if (!raw) return ''
  try {
    const decoded =
      data.encrypt === 2 ? decodeURIComponent(Buffer.from(raw, 'base64').toString('utf-8'))
      : data.encrypt === 1 ? decodeURIComponent(raw)
      : raw
    return /^https?:\/\//i.test(decoded) ? decoded : ''
  } catch {
    return ''
  }
}

/** 某一集的播放页 → 真实播放地址(m3u8 或 mp4)。拿不到返回空串,由调用方兜底。 */
export async function resolveEpPlayUrl(epPageUrl: string): Promise<string> {
  const res = await giriSession.get(epPageUrl)
  giriSession.save()
  return extractPlayerUrl(res.body)
}

export async function watch(playUrl: string): Promise<GiriWatchInfo> {
  const res = await giriSession.get(playUrl)
  giriSession.save()
  const $ = cheerio.load(res.body)

  let title = ''
  const h3 = $('h3.slide-info-title').first()
  if (h3.length) {
    title = h3.text().trim()
  } else {
    title = $('title').text().split('_')[0].trim()
  }

  const sources: GiriSource[] = []

  // ── 主路径：tab + episode box（适用于 tab 服务端渲染的情况）───────────────────
  const $tabs = $('a.vod-playerUrl, a[data-form]')
  const $boxes = $('.anthology-list-box')
  console.log(`[girigiri:watch] tabs=${$tabs.length} boxes=${$boxes.length} url=${playUrl}`)

  if ($tabs.length > 0 && $boxes.length > 0) {
    $tabs.each((i, tab) => {
      const dataForm = $(tab).attr('data-form') ?? ''
      const tabText = $(tab).clone().children('.badge').remove().end().text().trim()
      const sourceName = DATA_FORM_MAP[dataForm] || tabText || `片源${i + 1}`
      const eps: GiriEpisode[] = []
      $boxes.eq(i).find('ul.anthology-list-play li a, ul.anthology-list-play a').each((_, el) => {
        const href = $(el).attr('href') ?? ''
        if (!href) return
        const idx = eps.length + 1
        const epName = $(el).find('span').first().text().trim() || $(el).text().trim() || `第${idx}集`
        eps.push({ idx, name: epName, url: resolveUrl(href) })
      })
      console.log(`[girigiri:watch]   source[${i}] data-form="${dataForm}" name="${sourceName}" eps=${eps.length}`)
      if (eps.length > 0) sources.push({ name: sourceName, episodes: eps })
    })
  }

  // ── fallback：列表页 tab 是 JS 动态渲染（tabs=0），但 boxes 解析成功 ──────────
  if (sources.length === 0 && $boxes.length > 0) {
    // Step 1: 从各 box 收集集数，记录每个 box 的第一集 URL
    const boxList: { firstEpUrl: string; eps: GiriEpisode[] }[] = []
    $boxes.each((_, box) => {
      const eps: GiriEpisode[] = []
      let firstEpUrl = ''
      $(box).find('ul li a').each((_, el) => {
        const href = $(el).attr('href') ?? ''
        if (!href) return
        const url2 = resolveUrl(href)
        if (!firstEpUrl) firstEpUrl = url2
        const idx = eps.length + 1
        eps.push({ idx, name: $(el).text().trim() || `第${idx}集`, url: url2 })
      })
      if (eps.length) boxList.push({ firstEpUrl, eps })
    })

    // Step 2: 用播放页（PHP 服务端渲染）获取片源名
    const firstEpUrls = boxList.map(b => b.firstEpUrl).filter(Boolean)
    const sourceNames = await resolveSourceNamesFromPlayerPage(firstEpUrls)

    // Step 3: 组装 sources
    boxList.forEach((box, i) => {
      const name = sourceNames[i] || `片源${i + 1}`
      sources.push({ name, episodes: box.eps })
      console.log(`[girigiri:watch]   fallback-box[${i}] name="${name}" eps=${box.eps.length}`)
    })
  }

  // ── 兜底：连 boxes 都没有 ─────────────────────────────────────────────────────
  if (sources.length === 0) {
    console.warn('[girigiri:watch] no sources found via box parsing, trying generic selectors...')
    const fallbackEps: GiriEpisode[] = []
    for (const sel of ['.anthology-list-play', 'div[class*="anthology"]', 'div[class*="episode-list"]']) {
      const $container = $(sel).first()
      if (!$container.length) continue
      $container.find('li a').each((_, el) => {
        const href = $(el).attr('href') ?? ''
        if (!href) return
        const idx = fallbackEps.length + 1
        fallbackEps.push({ idx, name: $(el).text().trim() || `第${idx}集`, url: resolveUrl(href) })
      })
      if (fallbackEps.length) break
    }
    if (!fallbackEps.length) {
      const seen = new Set<string>()
      let idx = 1
      for (const m of res.body.matchAll(/href=["']([^"']*\/play[^"']*)["']/g)) {
        const url2 = resolveUrl(m[1])
        if (!seen.has(url2)) { seen.add(url2); fallbackEps.push({ idx, name: `第${idx}集`, url: url2 }); idx++ }
      }
    }
    if (fallbackEps.length) sources.push({ name: '默认片源', episodes: fallbackEps })
  }

  if (!sources.length) {
    console.warn('[girigiri:watch] 0 episodes parsed. URL:', playUrl)
  }

  return { title, sources, episodes: sources[0]?.episodes ?? [] }
}
