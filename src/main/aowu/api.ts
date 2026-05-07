/**
 * Aowu (嗷呜动漫) API — search + watch.
 *
 * 2026-05 site overhaul: switched off MacCMS dsn2 to a custom "FantasyKon" frontend.
 *   - search URL: /search?anime={kw}&page={N}  → 302 → /s/{token}?anime=...&page=...
 *   - cards: <article class="category-video-card"> with <a class="poster" href="/v/{token}">
 *   - pagination: button-driven UI but URL `&page=N` works directly
 *   - total pages: text "第 X / Y 页" in HTML body
 *
 * Watch / download URL pipeline still uses the old /play/{id}-{src}-{ep}/ pattern —
 * those flows will fail until url-resolver.ts and watch() below are also updated for
 * the new /v/{token} pattern. See the TODO marker in watch().
 */
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import * as cheerio from 'cheerio/slim'
import { DESKTOP_USER_AGENT } from '../shared/download-types'

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

interface FetchResultRaw { status: number; body: string; location: string | null }

function fetchPageOnce(url: string, extraHeaders?: Record<string, string>): Promise<FetchResultRaw> {
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
          const loc = res.headers.location
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            location: Array.isArray(loc) ? loc[0] ?? null : (loc ?? null),
          })
        })
        res.on('error', reject)
      }
    )
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
  })
}

/** GET that transparently follows 3xx redirects (up to 5 hops). */
export async function fetchPage(url: string, extraHeaders?: Record<string, string>): Promise<FetchResult> {
  let cur = url
  for (let i = 0; i < 6; i++) {
    const res = await fetchPageOnce(cur, extraHeaders)
    if (res.status >= 300 && res.status < 400 && res.location) {
      cur = new URL(res.location, cur).href
      continue
    }
    return { status: res.status, body: res.body }
  }
  throw new Error('Too many redirects')
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
 * Parse one search-results page into cards (new FantasyKon layout).
 *
 *   <article class="category-video-card">
 *     <a class="poster" href="/v/{token}" data-fk-raw-href="/video/{id}">
 *       <img src="..." alt="{title}" />
 *     </a>
 *     <h3><a href="/v/{token}">{title}</a></h3>
 *     <p>{epCount}|{updateDay}</p>      ← optional
 *     <strong>{rating}</strong>          ← optional
 *   </article>
 *
 * No year/area in cards anymore — they only appear on the detail page. We fill them
 * with empty strings to keep the AowuSearchResult shape stable.
 */
function parseSearchPage(html: string): AowuSearchResult[] {
  const $ = cheerio.load(html)
  const results: AowuSearchResult[] = []

  $('article.category-video-card').each((_, el) => {
    const $card = $(el)
    const $poster = $card.find('a.poster').first()
    const href = $poster.attr('href') || $card.find('h3 a').attr('href') || ''
    if (!href) return

    const title =
      $card.find('h3 a').first().text().trim() ||
      $card.find('h3').first().text().trim() ||
      $poster.find('img').attr('alt') ||
      ''
    if (!title) return

    const cover = $poster.find('img').attr('src') || ''
    const watch_url = new URL(href, BASE_URL).href

    results.push({ title, cover, year: '', area: '', watch_url })
  })

  return results
}

// Error markers — friendlyError translates these into user-facing title+hint.
const ERR_UNREACHABLE = 'AOWU_UNREACHABLE'
const ERR_STRUCTURE = 'AOWU_STRUCTURE_CHANGED'

// Detect "200 but body is a CDN error page" (e.g. 嗷呜's custom 523 page returns
// HTTP 200 wrapping the error UI on some routes / proxy chains).
function looksLikeErrorPage(html: string): boolean {
  return /源站响应超时|源站超时|origin\s+timeout|cf-error|connection\s+timed\s+out/i.test(html)
}

// "Did the page parse like a search results page?" — used to distinguish
// site改版 from "search ran, no matches" (latter has a recognizable empty-state).
function looksLikeSearchResultPage(html: string): boolean {
  return /category-video-card|category-pagination|搜索结果|没有找到相关内容/.test(html)
}

// Pagination: server emits "第 X / Y 页" text. Pull Y. Fall back to 1.
function parseTotalPages(html: string): number {
  const m = html.match(/第\s*\d+\s*\/\s*(\d+)\s*页/)
  if (!m) return 1
  const n = parseInt(m[1])
  return isNaN(n) || n < 1 ? 1 : n
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const PAGE_DELAY_MS = 800
const MAX_PAGES = 20

export async function search(keyword: string): Promise<AowuSearchResult[]> {
  const buildUrl = (page: number): string =>
    page <= 1
      ? `${BASE_URL}/search?anime=${encodeURIComponent(keyword)}`
      : `${BASE_URL}/search?anime=${encodeURIComponent(keyword)}&page=${page}`

  let firstRes: FetchResult
  try {
    firstRes = await fetchPage(buildUrl(1))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`${ERR_UNREACHABLE}: 网络请求失败 (${msg})`)
  }

  // 5xx including 523 (Cloudflare 源站不可达)
  if (firstRes.status >= 500 && firstRes.status < 600) {
    throw new Error(`${ERR_UNREACHABLE}: HTTP ${firstRes.status}`)
  }
  if (firstRes.status !== 200) {
    throw new Error(`AOWU_HTTP_${firstRes.status}: HTTP ${firstRes.status}`)
  }
  if (looksLikeErrorPage(firstRes.body)) {
    throw new Error(`${ERR_UNREACHABLE}: 站点返回了 CDN 错误页`)
  }

  // 0 cards + no recognizable search-results markup ⇒ site has changed shape again.
  // (vs. 0 cards + "没有找到相关内容" page = real "no matches" — return [].)
  const firstPage = parseSearchPage(firstRes.body)
  if (firstPage.length === 0 && !looksLikeSearchResultPage(firstRes.body)) {
    throw new Error(`${ERR_STRUCTURE}: 搜索页 HTML 不含已知 FantasyKon 标记`)
  }

  // Walk remaining pages by incrementing `page` until we hit total or an empty page.
  const total = Math.min(parseTotalPages(firstRes.body), MAX_PAGES)
  const all: AowuSearchResult[] = [...firstPage]
  for (let p = 2; p <= total; p++) {
    await sleep(PAGE_DELAY_MS)
    let res: FetchResult
    try { res = await fetchPage(buildUrl(p)) }
    catch { break } // network blip — return what we have rather than hard-fail
    if (res.status !== 200) break
    const items = parseSearchPage(res.body)
    if (items.length === 0) break // server clamps over-the-end pages to empty
    all.push(...items)
  }
  return all
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
  // The new search returns /v/{token} URLs but watch/download pipeline still
  // assumes the legacy /play/{id}-{src}-{ep}/ format. Fail clearly instead of
  // crashing on missing `var player_aaaa`.
  if (/\/v\//.test(new URL(watchUrl).pathname)) {
    throw new Error('AOWU_WATCH_NOT_ADAPTED: 详情/下载流程未适配新版 /v/{token} 路径')
  }

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
