/**
 * Aowu video URL resolver — FantasyKon (post-2026-05) flow.
 *
 * Two-step protocol against the encrypted /api/site/secure endpoint:
 *   1. bundle(bundle_page="play", id, source_id, episode) → { play_token: { token } }
 *   2. play(id, token=play_token)                          → { url: <signed CDN mp4> }
 *
 * The resolved URL is a signed ByteDance CDN link (lf*-imcloud-file-sign.bytetos.com),
 * supports HTTP Range, and stays valid for several hours — long enough for the
 * downstream chunked-Range download to complete.
 *
 * `watchUrl` is `${BASE_URL}/w/{idOrToken}#s={src}&ep={ep}`. The hash carries
 * source_id and episode; the path tail carries our `id`. After the BrowserWindow
 * → HTTP refactor we put numeric video ids in the path; legacy queues may carry
 * an opaque play_token there, in which case we route() it first.
 */
import { BASE_URL, callSecure, ERR_STRUCTURE } from './secure'
import { URL } from 'node:url'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface PlayBundleData {
  data: {
    play_token: { token: string }
  }
}

interface PlayUrlData {
  url: string
  video_id?: number
  episode_no?: number
}

interface RouteData {
  video_id: number
}

interface WatchPathParts {
  id: number
  sourceId: number
  ep: number
}

async function parseWatchUrl(watchUrl: string): Promise<WatchPathParts> {
  const u = new URL(watchUrl)
  const pathM = /^\/w\/([^/?#]+)/.exec(u.pathname)
  if (!pathM) {
    throw new Error(`${ERR_STRUCTURE}: 期望 /w/{token}# 形式的播放 URL，收到 ${u.pathname}`)
  }
  const tail = decodeURIComponent(pathM[1])

  // Hash carries `s=...&ep=...`. URL parses hash as a single string starting with `#`.
  const hash = u.hash.replace(/^#/, '')
  const sM = /(?:^|&)s=(\d+)/.exec(hash)
  const epM = /(?:^|&)ep=(\d+)/.exec(hash)
  if (!sM || !epM) {
    throw new Error(`${ERR_STRUCTURE}: URL hash 缺少 s/ep 参数 (${u.hash})`)
  }
  const sourceId = parseInt(sM[1], 10)
  const ep = parseInt(epM[1], 10)

  let id: number
  if (/^\d+$/.test(tail)) {
    id = parseInt(tail, 10)
  } else {
    // Legacy: tail is an opaque play token. Route it.
    const r = await callSecure<RouteData>({ action: 'route', params: { token: tail } })
    if (!r?.video_id) {
      throw new Error(`${ERR_STRUCTURE}: route 未返回 video_id (token=${tail})`)
    }
    id = r.video_id
  }
  return { id, sourceId, ep }
}

async function computeAowuMp4(watchUrl: string): Promise<string> {
  const { id, sourceId, ep } = await parseWatchUrl(watchUrl)

  const playRes = await callSecure<PlayBundleData>({
    action: 'bundle',
    params: { id, source_id: sourceId, episode: ep, bundle_page: 'play' },
  })
  const token = playRes?.data?.play_token?.token
  if (!token) {
    throw new Error(`${ERR_STRUCTURE}: bundle(play) 未返回 play_token.token`)
  }

  const r = await callSecure<PlayUrlData>({
    action: 'play',
    params: { id, token },
  })
  const url = r?.url
  if (!url || !/^https?:\/\//.test(url)) {
    throw new Error('AOWU_RESOLVE_FAILED: play 响应缺少有效 url')
  }
  return url
}

// ── Resolved-URL cache (persisted across Electron restarts) ─────────────────
// The signed ByteDance CDN URLs returned by play() stay valid for at least
// 24h in practice (verified by pasting into NDM after a day — still works).
// Both the download flow (download.ts) and the "copy mp4 link" flow
// (ipc/aowu.ts via the renderer) call resolveAowuMp4 with the *same* watch
// URL — yet without a cache, every call hits the encrypted endpoint twice
// (bundle + play, ~3-5s of round-trips).
//
// With this cache:
//   • Once download.ts resolves ep 1's URL to kick off the download, a
//     subsequent "copy URL" click on ep 1 returns instantly from disk.
//   • Resolving ep 2 to copy its URL while ep 1 is still downloading also
//     populates the cache, so when ep 1 finishes and ep 2 starts, the
//     download flow gets the cached URL — no second resolve.
//   • Concurrent calls for the same watchUrl coalesce on a single promise.
//   • Restarting Electron does NOT invalidate the cache — entries written
//     within the last 24h survive and resume the "instant copy" experience.
//
// Storage: a JSON map in `userData/aowu-url-cache.json`. Loaded lazily on
// first access (so the module can be imported before `app.whenReady()`).
// Writes are debounced (1s) so a burst of resolves coalesce into one flush.
// Stale (>24h) entries are filtered on load. If the file is corrupt the
// cache simply starts fresh — no hard failure.
interface CacheEntry { url: string; resolvedAt: number }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h — verified safe via NDM testing
const PERSIST_DEBOUNCE_MS = 1000
const urlCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<string>>()

let cacheFile: string | null = null
let cacheLoaded = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

function ensureLoaded(): void {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    cacheFile = join(app.getPath('userData'), 'aowu-url-cache.json')
    if (!existsSync(cacheFile)) return
    const obj = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, CacheEntry>
    const now = Date.now()
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.url === 'string' && typeof v.resolvedAt === 'number'
          && now - v.resolvedAt < CACHE_TTL_MS) {
        urlCache.set(k, v)
      }
    }
  } catch {
    // Corrupt cache or app not ready — fall through, in-memory map stays empty.
  }
}

function persist(): void {
  if (!cacheFile) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const obj: Record<string, CacheEntry> = {}
      for (const [k, v] of urlCache) obj[k] = v
      writeFileSync(cacheFile!, JSON.stringify(obj))
    } catch {
      // Disk errors are non-fatal — next session just re-resolves.
    }
  }, PERSIST_DEBOUNCE_MS)
}

/** Resolve a watch URL to its signed CDN mp4 URL. Cached (TTL 24h, on disk) + coalesced. */
export async function resolveAowuMp4(watchUrl: string): Promise<string> {
  ensureLoaded()
  const cached = urlCache.get(watchUrl)
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return cached.url
  }

  const existing = inflight.get(watchUrl)
  if (existing) return existing

  const p = (async (): Promise<string> => {
    try {
      const url = await computeAowuMp4(watchUrl)
      urlCache.set(watchUrl, { url, resolvedAt: Date.now() })
      persist()
      return url
    } finally {
      inflight.delete(watchUrl)
    }
  })()
  inflight.set(watchUrl, p)
  return p
}

/** Drop a cached entry — e.g. after the CDN returns 403 indicating expiry. */
export function invalidateAowuMp4(watchUrl: string): void {
  if (urlCache.delete(watchUrl)) persist()
}

/**
 * Construct the watch URL fed to {@link resolveAowuMp4}. Pure formatter — kept
 * around so the IPC handler can build the URL once and pass it through.
 */
export function buildAowuWatchUrl(animeToken: string, sourceId: number, epNum: number): string {
  return `${BASE_URL}/w/${animeToken}#s=${sourceId}&ep=${epNum}`
}
