/**
 * Aowu (嗷呜动漫) API — search + watch.
 *
 * Site uses the same MacCMS dsn2 template as xifan, so the HTML selectors are nearly
 * identical. Difference: video URLs are not template-able — each ep needs the 3-step
 * resolution flow in url-resolver.ts at download time. Watch only enumerates the play
 * pages.
 */
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import * as cheerio from 'cheerio/slim'
import { DESKTOP_USER_AGENT } from '../shared/download-types'
import { crawlAllPages } from '../shared/maccms-search-paginator'

export const BASE_URL = 'https://www.aowu.tv'

const HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
}

export interface AowuEpisode {
  idx: number    // used in /play/{id}-{src}-{idx}/
  label: string  // display label e.g. "01", "BD", "OVA"
}

export interface AowuSource {
  idx: number      // the {src} value in /play/{id}-{src}-{ep}/, 1-based
  name: string     // human label e.g. "T线"
  episodes: AowuEpisode[]
}

export interface AowuSearchResult {
  title: string
  cover: string
  year: string
  area: string
  watch_url: string  // absolute /play/{id}-1-1/ URL
}

export interface AowuWatchInfo {
  id: string                 // animeId, e.g. "iSAAAK"
  title: string
  sources: AowuSource[]
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

interface FetchResult { status: number; body: string }

export function fetchPage(url: string, extraHeaders?: Record<string, string>): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https
    const req = mod.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { ...HEADERS, ...(extraHeaders ?? {}) },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') })
        })
        res.on('error', reject)
      }
    )
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
  })
}

export function postForm(
  url: string,
  body: string,
  extraHeaders?: Record<string, string>
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https
    const req = mod.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Content-Length': Buffer.byteLength(body),
          ...(extraHeaders ?? {}),
        },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') })
        })
        res.on('error', reject)
      }
    )
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── search ────────────────────────────────────────────────────────────────────

/**
 * Parse one search-results page into cards.
 *
 * Each card is a `div.vod-detail.search-list` (same MacCMS dsn2 markup as xifan):
 *   - .detail-pic > img[data-src] — cover (lazy-loaded)
 *   - .detail-info > a > h3.slide-info-title — title
 *   - .detail-info ... div.vod-detail-bnt > a.button[href="/play/{id}-1-1/"] — play link
 *   - year / area come from anchors that link into /vods/year/ and /vods/area/.
 */
function parseSearchPage(html: string): AowuSearchResult[] {
  const $ = cheerio.load(html)
  const results: AowuSearchResult[] = []

  $('div.vod-detail.search-list').each((_, el) => {
    const $card = $(el)
    const title = $card.find('h3.slide-info-title').text().trim()
    const playHref = $card.find('div.vod-detail-bnt a.button').attr('href') ?? ''
    if (!title || !playHref) return

    const cover = $card.find('div.detail-pic img').attr('data-src') ?? ''
    const watch_url = new URL(playHref, BASE_URL).href
    const year = $card.find('a[href*="/vods/year/"]').first().text().trim()
    const area = $card.find('a[href*="/vods/area/"]').first().text().trim()

    results.push({ title, cover, year, area, watch_url })
  })

  return results
}

// Error markers — friendlyError translates these into user-facing title+hint.
// AOWU_UNREACHABLE: site/CDN can't deliver content (523, timeout, custom error page)
// AOWU_STRUCTURE_CHANGED: HTML loaded fine but our selectors don't match → site改版
// AOWU_HTTP_<code>: other HTTP non-2xx that doesn't fit "unreachable"
const ERR_UNREACHABLE = 'AOWU_UNREACHABLE'
const ERR_STRUCTURE = 'AOWU_STRUCTURE_CHANGED'

// Detect "200 but body is a CDN error page" (e.g. 嗷呜's custom 523 page returns
// HTTP 200 wrapping the error UI on some routes / proxy chains).
function looksLikeErrorPage(html: string): boolean {
  return /源站响应超时|源站超时|origin\s+timeout|cf-error|connection\s+timed\s+out/i.test(html)
}

// "Did the page parse like a MacCMS search results page?" — used to distinguish
// site改版 from genuinely-zero matches.
function looksLikeSearchResultPage(html: string): boolean {
  return /vod-detail|search-list|slide-info-title|anthology-tab|class="vod-list/.test(html)
}

export async function search(keyword: string): Promise<AowuSearchResult[]> {
  const firstUrl = `${BASE_URL}/vods/?wd=${encodeURIComponent(keyword)}`

  let firstRes: FetchResult
  try {
    firstRes = await fetchPage(firstUrl)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`${ERR_UNREACHABLE}: 网络请求失败 (${msg})`)
  }

  // 5xx including 523 (Cloudflare 源站不可达) → unreachable
  if (firstRes.status >= 500 && firstRes.status < 600) {
    throw new Error(`${ERR_UNREACHABLE}: HTTP ${firstRes.status}`)
  }
  if (firstRes.status !== 200) {
    throw new Error(`AOWU_HTTP_${firstRes.status}: HTTP ${firstRes.status}`)
  }
  // Site uses Cloudflare-like custom error pages that sometimes return 200
  if (looksLikeErrorPage(firstRes.body)) {
    throw new Error(`${ERR_UNREACHABLE}: 站点返回了 CDN 错误页`)
  }

  // Heuristic: if 0 cards parsed AND none of the expected MacCMS markers are
  // present in the HTML, the site has been redesigned. Surfacing this as a
  // distinct error (vs. silently empty results) tells the user to update the
  // parser instead of assuming the keyword has no matches.
  const firstPage = parseSearchPage(firstRes.body)
  if (firstPage.length === 0 && !looksLikeSearchResultPage(firstRes.body)) {
    throw new Error(`${ERR_STRUCTURE}: 搜索页 HTML 不含已知的 MacCMS 标记`)
  }

  // Sequential pagination via shared helper — follows `下一页` links with 1s delay.
  return crawlAllPages({
    firstHtml: firstRes.body,
    baseUrl: BASE_URL,
    parsePage: parseSearchPage,
    fetchHtml: async (url) => {
      const r = await fetchPage(url)
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      return r.body
    },
  })
}

// ── watch ─────────────────────────────────────────────────────────────────────

export interface PlayerData {
  url: string       // base64+escape encoded — caller decodes via url-resolver
  encrypt: number
  from: string
  id: string
  sid: number       // current source idx (1-based)
  nid: number       // current ep idx (1-based)
  vod_data?: { vod_name?: string }
}

/**
 * Extract `var player_aaaa = {...}` JSON from a play page.
 * Handles single-line and pretty-printed forms.
 */
export function parsePlayerData(html: string): PlayerData | null {
  const m = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)
  if (!m) return null
  try { return JSON.parse(m[1]) as PlayerData } catch { return null }
}

/**
 * Parse the source tab list (.anthology-tab a.vod-playerUrl).
 * Returns each source's display name keyed by `from` (data-form attribute).
 */
function parseSourceTabs(html: string): { from: string; name: string }[] {
  const $ = cheerio.load(html)
  const sources: { from: string; name: string }[] = []
  $('div.anthology-tab a.vod-playerUrl').each((_, a) => {
    const $a = $(a)
    const from = $a.attr('data-form') ?? ''
    if (!from) return
    // Strip <i> icons + non-breaking-space prefixes from the visible label.
    const name = $a.contents()
      .filter((_, n) => n.type === 'text')
      .map((_, n) => $(n).text())
      .get()
      .join('')
      .replace(/ /g, ' ')
      .trim()
    sources.push({ from, name: name || from })
  })
  return sources
}

/**
 * Parse the episode list for one source.
 * `boxIndex` selects which `.anthology-list-box` to read — all sources' lists live in
 * the same HTML page, so we must scope to the right box to avoid mixing episodes from
 * different sources. Falls back to the whole document when no boxes are present.
 */
function parseEpisodes(html: string, boxIndex = 0): AowuEpisode[] {
  const $ = cheerio.load(html)
  const $boxes = $('.anthology-list-box')
  const $scope = $boxes.length > 0 ? $boxes.eq(boxIndex) : $('body')

  const eps: AowuEpisode[] = []
  $scope.find('ul.anthology-list-play li a').each((_, a) => {
    const $a = $(a)
    const href = $a.attr('href') ?? ''
    const m = /\/play\/[^/]+-\d+-(\d+)\/?$/.exec(href)
    if (!m) return
    const idx = parseInt(m[1])
    if (isNaN(idx)) return
    const label = $a.find('span').first().text().trim() || String(idx)
    eps.push({ idx, label })
  })
  eps.sort((a, b) => a.idx - b.idx)
  // Safety-dedup: drop consecutive entries with identical idx (e.g. duplicated markup).
  return eps.filter((ep, i) => i === 0 || ep.idx !== eps[i - 1].idx)
}

/**
 * Map `from` (e.g. "Moe-T") to the {src} idx used in URLs.
 * MacCMS exposes this only via per-source play page navigation: the `sid` field of
 * `player_aaaa` on /play/{id}-{N}-1/ is N. We probe each source's ep1 page once.
 */
async function resolveSourceIdx(animeId: string, fromValues: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  // sid 1 corresponds to the page we land on by default; for the rest we have to probe.
  // Try idx 1..N — stop once we've covered every from value.
  for (let i = 1; i <= fromValues.length + 2 && map.size < fromValues.length; i++) {
    const url = `${BASE_URL}/play/${animeId}-${i}-1/`
    try {
      const res = await fetchPage(url)
      if (res.status !== 200) continue
      const data = parsePlayerData(res.body)
      if (!data || map.has(data.from)) continue
      map.set(data.from, i)
    } catch { /* ignore probe failures */ }
  }
  return map
}

/**
 * `watchUrl` may be either /play/{id}-1-1/ (direct from search) or any /play/{id}-{src}-{ep}/.
 * Returns the title + animeId + every source's full episode list.
 */
export async function watch(watchUrl: string): Promise<AowuWatchInfo> {
  const res = await fetchPage(watchUrl)
  if (res.status !== 200) throw new Error(`Watch fetch failed: HTTP ${res.status}`)
  const html = res.body

  const data = parsePlayerData(html)
  if (!data) throw new Error('Failed to parse player_aaaa from play page')

  const animeId = data.id
  const title = data.vod_data?.vod_name ?? ''

  const sourceTabs = parseSourceTabs(html)
  if (sourceTabs.length === 0) {
    // Fallback: only the source we landed on.
    const eps = parseEpisodes(html, 0)
    return {
      id: animeId,
      title,
      sources: [{ idx: data.sid || 1, name: data.from || 'default', episodes: eps }],
    }
  }

  // The N-th source tab corresponds to the N-th anthology-list-box in the HTML.
  const currentTabIdx = sourceTabs.findIndex(t => t.from === data.from)
  const currentEps = parseEpisodes(html, currentTabIdx >= 0 ? currentTabIdx : 0)
  const fromIdxMap = new Map<string, number>([[data.from, data.sid || 1]])

  // Probe other sources to learn their {src} idx and ep list.
  const otherFroms = sourceTabs.map((s) => s.from).filter((f) => !fromIdxMap.has(f))
  if (otherFroms.length > 0) {
    const probed = await resolveSourceIdx(animeId, [...fromIdxMap.keys(), ...otherFroms])
    for (const [from, idx] of probed) fromIdxMap.set(from, idx)
  }

  const sources: AowuSource[] = []
  for (const tab of sourceTabs) {
    const idx = fromIdxMap.get(tab.from)
    if (!idx) continue
    if (tab.from === data.from) {
      sources.push({ idx, name: tab.name, episodes: currentEps })
    } else {
      try {
        const probe = await fetchPage(`${BASE_URL}/play/${animeId}-${idx}-1/`)
        if (probe.status === 200) {
          const probeData = parsePlayerData(probe.body)
          const probeTabIdx = probeData
            ? sourceTabs.findIndex(t => t.from === probeData.from)
            : -1
          sources.push({ idx, name: tab.name, episodes: parseEpisodes(probe.body, probeTabIdx >= 0 ? probeTabIdx : 0) })
        } else {
          sources.push({ idx, name: tab.name, episodes: [] })
        }
      } catch {
        sources.push({ idx, name: tab.name, episodes: [] })
      }
    }
  }

  return { id: animeId, title, sources }
}
