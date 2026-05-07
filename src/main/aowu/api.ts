/**
 * Aowu (嗷呜动漫) API — search + watch.
 *
 * 2026-05 site overhaul: switched from MacCMS dsn2 to a custom "FantasyKon" frontend.
 * The new site is a pure SPA — search / detail / watch pages all return a 2797-byte
 * shell on direct HTTP requests; real content is hydrated by JS after the SPA POSTs
 * to a private encrypted endpoint (`/api/site/secure`). We can't replicate that
 * crypto in Node practically, so all operations drive a hidden BrowserWindow
 * (see headless.ts) and read the populated DOM.
 *
 * URL patterns:
 *   - search: /search?anime={kw}&page={N}  (top-level nav 302→ /s/{token}?anime=...)
 *   - detail: /v/{anime_token}
 *   - watch:  /w/{anime_token}#s={source_id}&ep={ep_num}
 *   - mp4:    signed CDN URL on lf*-imcloud-file-sign.bytetos.com (set onto <video>.src)
 */
import { navigate, evalInPage, clickInPage, waitFor, setPageGlobal } from './headless'

export const BASE_URL = 'https://www.aowu.tv'

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
  year: string       // empty in new layout (only on detail page)
  area: string       // empty in new layout (only on detail page)
  watch_url: string  // absolute /v/{token} URL
}

export interface AowuWatchInfo {
  id: string                 // anime token, e.g. "_2jACJ3_AIQE"
  title: string
  sources: AowuSource[]
}

const ERR_UNREACHABLE = 'AOWU_UNREACHABLE'
const ERR_STRUCTURE = 'AOWU_STRUCTURE_CHANGED'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── search ────────────────────────────────────────────────────────────────────

const PAGE_DELAY_MS = 600
const MAX_PAGES = 20

interface ScrapedCard {
  title: string
  cover: string
  href: string
}

async function scrapeCardsFromCurrentPage(): Promise<ScrapedCard[]> {
  return evalInPage<ScrapedCard[]>(() => {
    const cards = Array.from(document.querySelectorAll('article.category-video-card'))
    return cards.map(c => {
      const poster = c.querySelector('a.poster') as HTMLAnchorElement | null
      const titleEl = c.querySelector('h3 a') || c.querySelector('h3')
      const img = poster?.querySelector('img') as HTMLImageElement | null
      const href = poster?.getAttribute('href')
        || (c.querySelector('h3 a') as HTMLAnchorElement | null)?.getAttribute('href')
        || ''
      const title =
        (titleEl?.textContent || '').trim()
        || img?.getAttribute('alt')
        || ''
      const cover = img?.getAttribute('src') || ''
      return { title, cover, href }
    }).filter(c => c.title && c.href)
  })
}

function toResults(cards: ScrapedCard[]): AowuSearchResult[] {
  return cards.map(c => ({
    title: c.title,
    cover: c.cover,
    year: '',
    area: '',
    watch_url: c.href.startsWith('http') ? c.href : new URL(c.href, BASE_URL).href,
  }))
}

export async function search(keyword: string): Promise<AowuSearchResult[]> {
  const buildUrl = (page: number): string =>
    page <= 1
      ? `${BASE_URL}/search?anime=${encodeURIComponent(keyword)}`
      : `${BASE_URL}/search?anime=${encodeURIComponent(keyword)}&page=${page}`

  // Page 1
  try {
    await navigate(buildUrl(1))
  } catch (e) {
    throw new Error(`${ERR_UNREACHABLE}: 搜索页加载失败 (${e instanceof Error ? e.message : String(e)})`)
  }

  // Wait for one of:
  //   - cards rendered (results found)
  //   - "没有找到相关内容" appears (genuine zero-match)
  //   - timeout (unreachable / structure changed)
  try {
    await waitFor(() => {
      if (document.querySelectorAll('article.category-video-card').length > 0) return true
      const text = document.body?.textContent || ''
      return text.includes('没有找到相关内容')
    }, 20000, 250)
  } catch {
    // SPA never populated. Could be CDN error / network / new structure.
    const errorIndicator = await evalInPage<string>(() => {
      const text = document.body?.textContent || ''
      if (/源站响应超时|源站超时|origin\s+timeout/i.test(text)) return 'unreachable'
      if (document.querySelector('.search-result, .category-video-card, .episode-grid')) return 'partial'
      return 'unknown'
    }).catch(() => 'unknown')
    if (errorIndicator === 'unreachable') {
      throw new Error(`${ERR_UNREACHABLE}: 站点返回了 CDN 错误页`)
    }
    throw new Error(`${ERR_STRUCTURE}: 搜索页 SPA 未在预期时间内渲染出卡片或空状态`)
  }

  const firstCards = await scrapeCardsFromCurrentPage()
  if (firstCards.length === 0) return []

  // Read total page count from "第 X / Y 页" text in DOM
  const totalPages = await evalInPage<number>(() => {
    const m = /第\s*\d+\s*\/\s*(\d+)\s*页/.exec(document.body?.textContent || '')
    return m ? parseInt(m[1]) : 1
  })

  const all: AowuSearchResult[] = toResults(firstCards)
  const total = Math.min(totalPages, MAX_PAGES)
  for (let p = 2; p <= total; p++) {
    await sleep(PAGE_DELAY_MS)
    try {
      await navigate(buildUrl(p))
      await waitFor(
        () => document.querySelectorAll('article.category-video-card').length > 0,
        10000, 250
      )
    } catch {
      break
    }
    const items = await scrapeCardsFromCurrentPage()
    if (items.length === 0) break
    all.push(...toResults(items))
  }
  return all
}

// ── watch (detail page) ────────────────────────────────────────────────────────

/**
 * Detail page (/v/{token}) — JS-rendered SPA. We drive it from a hidden
 * BrowserWindow:
 *   1. Load /v/{token}, wait for .episode-grid to populate
 *   2. Read tab names + first source's eps (whichever is active by default)
 *   3. Click each remaining tab, wait for ep grid to switch, read its eps
 *
 * Episode hrefs encode source/ep as `/w/{anime}#s={source_id}&ep={N}`, which is
 * how we extract opaque source IDs (no DOM data attributes available).
 *
 * Accepts either /v/{token} or /w/{token}#... (search hands us /v/, but we tolerate
 * either to keep callers simple).
 */
export async function watch(watchUrl: string): Promise<AowuWatchInfo> {
  const u = new URL(watchUrl)
  if (u.pathname.startsWith('/play/')) {
    throw new Error('AOWU_STRUCTURE_CHANGED: 旧版 /play/ 路径已不可用，需要从搜索重新进入')
  }
  const detailUrl = u.pathname.startsWith('/w/')
    ? `${u.origin}/v/${u.pathname.slice(3)}`
    : watchUrl
  const animeToken = decodeURIComponent(new URL(detailUrl).pathname.replace(/^\/v\//, ''))

  // Step 1: load detail page once and wait for the SPA to hydrate.
  await navigate(detailUrl)
  await waitFor(() => {
    const grid = document.querySelector('.episode-grid')
    const titleEl = document.querySelector('h1, h2.video-title, .video-title h1')
    return !!(grid && grid.children && grid.children.length > 0 && titleEl)
  }, 25000, 200)

  // Step 2: read static metadata + the currently-active source's episodes.
  const initial = await evalInPage<{
    title: string
    sourceNames: string[]
    sourceId: number
    episodes: AowuEpisode[]
  }>(() => {
    const titleEl = document.querySelector('h1, h2.video-title, .video-title h1')
    const title = (titleEl?.textContent || '').trim()
    const tabs = Array.from(document.querySelectorAll('.episode-head button'))
    const sourceNames = tabs.map(b => (b.textContent || '').trim()).filter(Boolean)
    const grid = document.querySelector('.episode-grid')
    const firstHref = grid?.firstElementChild?.getAttribute('href') || ''
    const m = /[#&]s=(\d+)/.exec(firstHref)
    const sourceId = m ? parseInt(m[1]) : 0
    const episodes = Array.from(grid?.children || []).map(a => {
      const href = (a as HTMLAnchorElement).getAttribute('href') || ''
      const epM = /[#&]ep=(\d+)/.exec(href)
      const idx = epM ? parseInt(epM[1]) : 0
      const label = (a.textContent || '').trim() || String(idx)
      return { idx, label }
    }).filter(e => e.idx > 0)
    return { title, sourceNames, sourceId, episodes }
  })

  const sources: AowuSource[] = []
  const seenSourceIds = new Set<number>()
  if (initial.sourceId && initial.episodes.length > 0) {
    sources.push({
      idx: initial.sourceId,
      name: initial.sourceNames[0] || 'default',
      episodes: initial.episodes,
    })
    seenSourceIds.add(initial.sourceId)
  }

  // Step 3: click each remaining source tab and read the new ep grid.
  // We detect the tab actually switched by waiting for the grid's first ep href
  // to point at a source_id we haven't seen yet — list passed via window global
  // because predicate is serialized with toString() (no closure capture).
  for (let i = 1; i < initial.sourceNames.length; i++) {
    await setPageGlobal('__mtSeenSources', Array.from(seenSourceIds))
    await clickInPage('.episode-head button', i)
    let switched = false
    try {
      await waitFor(() => {
        const seen = ((window as unknown as { __mtSeenSources?: number[] }).__mtSeenSources) || []
        const a = document.querySelector('.episode-grid > *')
        const href = a?.getAttribute('href') || ''
        const m = /[#&]s=(\d+)/.exec(href)
        if (!m) return false
        return !seen.includes(parseInt(m[1]))
      }, 8000, 150)
      switched = true
    } catch { /* tab click might be a no-op if same source */ }
    if (!switched) continue

    const data = await evalInPage<{ sourceId: number; episodes: AowuEpisode[] }>(() => {
      const grid = document.querySelector('.episode-grid')
      const firstHref = grid?.firstElementChild?.getAttribute('href') || ''
      const m = /[#&]s=(\d+)/.exec(firstHref)
      const sourceId = m ? parseInt(m[1]) : 0
      const episodes = Array.from(grid?.children || []).map(a => {
        const href = (a as HTMLAnchorElement).getAttribute('href') || ''
        const epM = /[#&]ep=(\d+)/.exec(href)
        const idx = epM ? parseInt(epM[1]) : 0
        const label = (a.textContent || '').trim() || String(idx)
        return { idx, label }
      }).filter(e => e.idx > 0)
      return { sourceId, episodes }
    })

    if (data.sourceId && !seenSourceIds.has(data.sourceId) && data.episodes.length > 0) {
      sources.push({
        idx: data.sourceId,
        name: initial.sourceNames[i] || `线路${i + 1}`,
        episodes: data.episodes,
      })
      seenSourceIds.add(data.sourceId)
    }
  }

  return { id: animeToken, title: initial.title, sources }
}
