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

export async function search(keyword: string): Promise<AowuSearchResult[]> {
  const url = `${BASE_URL}/vods/?wd=${encodeURIComponent(keyword)}`
  const res = await fetchPage(url)
  if (res.status !== 200) throw new Error(`Search failed: HTTP ${res.status}`)

  const $ = cheerio.load(res.body)
  const results: AowuSearchResult[] = []

  // The search page nests result cards similarly to xifan's layout. Each card has:
  //   - h3.slide-info-title for the title (wrapped in <a href="/bangumi/..">)
  //   - div.vod-detail-bnt a.button → href="/play/{id}-1-1/"
  //   - img with data-src for the cover
  //   - span.slide-info-remarks for episode count / year / area (sometimes split into spans)
  $('h3.slide-info-title').each((_, h3) => {
    const $card = $(h3).closest('.row, .vod-detail, .v-list-item, div').first()
    // Walk up to find the wrapper that contains both the title and the play button.
    // Fall back to nearest ancestor that has the play link.
    let $wrap = $card
    if ($wrap.find('div.vod-detail-bnt a.button').length === 0) {
      $wrap = $(h3).parents().filter((_, p) => $(p).find('div.vod-detail-bnt a.button').length > 0).first()
    }
    if (!$wrap || $wrap.length === 0) return

    const title = $(h3).text().trim()
    const playHref = $wrap.find('div.vod-detail-bnt a.button').attr('href') ?? ''
    if (!playHref) return
    const watch_url = new URL(playHref, BASE_URL).href

    const cover = $wrap.find('img').attr('data-src') ?? ''

    // Year + area come from /vods/year/.. and /vods/area/.. anchors when present.
    const year = $wrap.find('a[href*="/vods/year/"]').first().text().trim()
    const area = $wrap.find('a[href*="/vods/area/"]').first().text().trim()

    if (title) results.push({ title, cover, year, area, watch_url })
  })

  return results
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
 * Parse the episode list for the currently displayed source.
 * Pulls `{idx, label}` from each `<li><a href="/play/{id}-{src}-{idx}/"><span>{label}</span>...`
 */
function parseEpisodes(html: string): AowuEpisode[] {
  const $ = cheerio.load(html)
  const eps: AowuEpisode[] = []
  $('ul.anthology-list-play li a').each((_, a) => {
    const $a = $(a)
    const href = $a.attr('href') ?? ''
    const m = /\/play\/[^/]+-\d+-(\d+)\/?$/.exec(href)
    if (!m) return
    const idx = parseInt(m[1])
    if (isNaN(idx)) return
    const label = $a.find('span').first().text().trim() || String(idx)
    eps.push({ idx, label })
  })
  // Sort by idx ascending — ensures display order matches sequential URL idx.
  eps.sort((a, b) => a.idx - b.idx)
  return eps
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
    const eps = parseEpisodes(html)
    return {
      id: animeId,
      title,
      sources: [{ idx: data.sid || 1, name: data.from || 'default', episodes: eps }],
    }
  }

  // We already have full ep list for the source we landed on.
  const currentEps = parseEpisodes(html)
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
        sources.push({ idx, name: tab.name, episodes: probe.status === 200 ? parseEpisodes(probe.body) : [] })
      } catch {
        sources.push({ idx, name: tab.name, episodes: [] })
      }
    }
  }

  return { id: animeId, title, sources }
}
