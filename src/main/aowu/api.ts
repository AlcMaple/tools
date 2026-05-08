/**
 * Aowu (嗷呜动漫) API — search + watch.
 *
 * 2026-05 site overhaul: switched from MacCMS dsn2 to a custom "FantasyKon" frontend
 * with everything behind an encrypted POST /api/site/secure. We replicate the
 * protocol directly in Node (see ./secure.ts) and skip the browser entirely.
 *
 * Verbs we issue here:
 *   - bundle({bundle_page:"search", anime})         search results
 *   - route({token})                                URL token → numeric video_id
 *   - bundle({bundle_page:"video", id})             detail incl. sources & episodes
 */
import { BASE_URL, callSecure, ERR_STRUCTURE } from './secure'

export { BASE_URL }

export interface AowuEpisode {
  idx: number    // ep number (1, 2, ...)
  label: string  // display label e.g. "第01话", "BD", "OVA"
}

export interface AowuSource {
  idx: number      // FantasyKon's opaque source_id (e.g. 4116) — used as #s={idx} in /w/...
  name: string     // human label e.g. "D线"
  episodes: AowuEpisode[]
}

export interface AowuSearchResult {
  title: string
  cover: string
  year: string
  area: string
  watch_url: string  // ${BASE_URL}/v/{numericId} — opaque, round-tripped to watch()
}

export interface AowuWatchInfo {
  id: string             // numeric video id as string ("2893") — passed to download.ts
  title: string
  sources: AowuSource[]
}

// ── Search ────────────────────────────────────────────────────────────────────

interface SearchListItem {
  id: number
  name?: string
  pic?: string
  year?: string | number
  area?: string
  type_name?: string
  remarks?: string
}

interface BundleSearchData {
  page: string
  data: { query: string; list: SearchListItem[]; page: number; limit: number; total: number }
}

// Defensive cap. With limit=10/page this is 200 results — more than any real search.
const MAX_SEARCH_PAGES = 20

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/**
 * Decode HTML entities (named + numeric, dec/hex). Iterative because the API
 * sometimes returns double-encoded values (e.g. `&amp;#039;` → `&#039;` → `'`).
 * Bounded at 3 passes to defuse pathological loops.
 */
function decodeEntities(s: string): string {
  let prev = ''
  let cur = s
  for (let i = 0; i < 3 && cur !== prev; i++) {
    prev = cur
    cur = cur.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        if (Number.isFinite(n) && n >= 0 && n <= 0x10ffff) return String.fromCodePoint(n)
        return m
      }
      const repl = NAMED_ENTITIES[code.toLowerCase()]
      return repl !== undefined ? repl : m
    })
  }
  return cur
}

function toResult(it: SearchListItem): AowuSearchResult {
  return {
    title: decodeEntities(it.name ?? ''),
    cover: it.pic ?? '',
    year: it.year != null ? String(it.year) : '',
    area: it.area ?? '',
    // We anchor on the numeric id. The /v/{id} URL is synthetic — we never
    // visit it, just round-trip it back into watch() which reads the path tail.
    watch_url: `${BASE_URL}/v/${it.id}`,
  }
}

export async function search(keyword: string): Promise<AowuSearchResult[]> {
  // Page 1 — also tells us total + limit so we know how many more pages to fetch.
  const first = await callSecure<BundleSearchData>({
    action: 'bundle',
    params: { bundle_page: 'search', anime: keyword, page: 1 },
  })
  const inner = first?.data
  if (!inner || !Array.isArray(inner.list)) {
    throw new Error(`${ERR_STRUCTURE}: 搜索响应缺少 data.data.list`)
  }

  const limit = inner.limit > 0 ? inner.limit : 10
  const total = typeof inner.total === 'number' ? inner.total : inner.list.length
  const totalPages = Math.min(Math.ceil(total / limit), MAX_SEARCH_PAGES)

  const all = inner.list.filter((it) => it && typeof it.id === 'number' && it.name).map(toResult)

  if (totalPages > 1) {
    // Pages 2..N in parallel — each call is ~150ms and the API is fast enough
    // that fan-out beats sequential. Errors on a single page are swallowed and
    // logged; partial results are better than none.
    const pages = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) =>
        callSecure<BundleSearchData>({
          action: 'bundle',
          params: { bundle_page: 'search', anime: keyword, page: i + 2 },
        }).catch((e) => {
          console.error(`[aowu] search page ${i + 2} failed:`, e instanceof Error ? e.message : e)
          return null
        })
      )
    )
    for (const p of pages) {
      const list = p?.data?.list
      if (!Array.isArray(list)) continue
      for (const it of list) {
        if (it && typeof it.id === 'number' && it.name) all.push(toResult(it))
      }
    }
  }

  return all
}

// ── Watch (detail page) ───────────────────────────────────────────────────────

interface RouteData {
  page: string
  video_id: number
}

interface BundleVideoData {
  page: string
  data: {
    video: { id: number; name: string; [k: string]: unknown }
    sources: Array<{ id: number; name: string; episodes: Array<{ id: number; no: number; name?: string }> }>
  }
}

/** Pull the path tail out of /v/{x} or /w/{x}. Does not throw. */
function parsePathTail(watchUrl: string): string {
  try {
    const u = new URL(watchUrl)
    const m = /^\/(?:v|w)\/([^/?#]+)/.exec(u.pathname)
    return m ? decodeURIComponent(m[1]) : ''
  } catch {
    return ''
  }
}

/**
 * Resolve a watch URL (`/v/{id-or-token}`) to detail. Both the new numeric form
 * (from search() above) and any legacy token form (from queues created before
 * this refactor) work — we route(token) once if the tail isn't numeric.
 */
export async function watch(watchUrl: string): Promise<AowuWatchInfo> {
  const tail = parsePathTail(watchUrl)
  if (!tail) throw new Error(`${ERR_STRUCTURE}: 无法从 URL 解析出 token (${watchUrl})`)

  let videoId: number
  if (/^\d+$/.test(tail)) {
    videoId = parseInt(tail, 10)
  } else {
    const route = await callSecure<RouteData>({
      action: 'route',
      params: { token: tail },
    })
    if (!route?.video_id) {
      throw new Error(`${ERR_STRUCTURE}: route 未返回 video_id (token=${tail})`)
    }
    videoId = route.video_id
  }

  const data = await callSecure<BundleVideoData>({
    action: 'bundle',
    params: { id: videoId, bundle_page: 'video' },
  })
  const inner = data?.data
  if (!inner?.video || !Array.isArray(inner.sources)) {
    throw new Error(`${ERR_STRUCTURE}: 详情响应缺少 video / sources`)
  }
  return {
    id: String(inner.video.id),
    title: decodeEntities(inner.video.name ?? ''),
    sources: inner.sources.map((s) => ({
      idx: s.id,
      name: decodeEntities(s.name ?? ''),
      episodes: (s.episodes ?? [])
        .filter((e) => e && typeof e.no === 'number')
        .map((e) => ({
          idx: e.no,
          label: decodeEntities(e.name || `第${String(e.no).padStart(2, '0')}话`),
        })),
    })),
  }
}
