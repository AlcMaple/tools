// 新站通过剧集 ID + 稳定线路 ID 签发媒体地址；保留共享并发预算和实测选线，禁止按文件名猜下一集。
import { NextError, nextPage } from '../../shared/xifan-next'
import { nextXifan } from './next'
import { canProxy } from './proxy-hosts'
import { measureThroughput } from './stream'
import { XifanUpstreamError } from './session'
export { BASE_URL, DESKTOP_UA, XifanUpstreamError } from './session'
const MAX_UPSTREAM_CONCURRENCY = 2
const MAX_UPSTREAM_WAITING = 8
const UPSTREAM_START_GAP_MS = 250
const CACHE_TTL_MS = 30_000
const MAX_CACHE_ENTRIES = 1000
const sessionGenerations = new Map<number, number>()
export class XifanBusyError extends Error {
  readonly retryAfterSec = 2
  constructor() { super('稀饭解析请求较多，请稍后再试') }
}
export type XifanResolveErrorCode = 'XIFAN_AUTH_REQUIRED' | 'XIFAN_ACCESS_DENIED'
export class XifanResolveError extends Error {
  constructor(readonly code: XifanResolveErrorCode, message: string) { super(message) }
}
export interface LineMeta { source: number; name: string }
export interface PlayLine { source: number; url: string; kind: 'mp4' | 'hls'; from: string }
export interface Playlist { title: string; lines: LineMeta[]; first: PlayLine | null; eps: number[] }
function scope(uid: number | null): string { return uid === null ? 'anon' : `user:${uid}:${sessionGenerations.get(uid) ?? 0}` }
async function upstream<T>(fn: () => Promise<T>): Promise<T> {
  try { return await withUpstreamSlot(fn) } catch (error) {
    if (error instanceof NextError) {
      if (['unauthorized', 'unauthenticated'].includes(error.code) || error.status === 401) throw new XifanResolveError('XIFAN_AUTH_REQUIRED', error.message)
      if (error.code === 'forbidden' || error.status === 403) throw new XifanResolveError('XIFAN_ACCESS_DENIED', error.message)
      throw new XifanUpstreamError(error.code === 'rate_limited' ? 429 : error.status, error.retryAfter, error.message)
    }
    throw error
  }
}
let upstreamActive = 0
const upstreamWaiters: Array<() => void> = []
let upstreamStartQueue = Promise.resolve()
let lastUpstreamStartedAt = 0

async function acquireUpstreamSlot(): Promise<void> {
  if (upstreamActive < MAX_UPSTREAM_CONCURRENCY) {
    upstreamActive++
    return
  }
  if (upstreamWaiters.length >= MAX_UPSTREAM_WAITING) throw new XifanBusyError()
  await new Promise<void>((resolve) => upstreamWaiters.push(resolve))
}

function releaseUpstreamSlot(): void {
  const next = upstreamWaiters.shift()
  if (next) next()
  else upstreamActive--
}

function scheduleUpstreamStart(): Promise<void> {
  const gate = upstreamStartQueue.then(async () => {
    const elapsed = Date.now() - lastUpstreamStartedAt
    if (elapsed < UPSTREAM_START_GAP_MS) {
      await new Promise((resolve) => setTimeout(resolve, UPSTREAM_START_GAP_MS - elapsed))
    }
    lastUpstreamStartedAt = Date.now()
  })
  upstreamStartQueue = gate.then(() => undefined, () => undefined)
  return gate
}

async function withUpstreamSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireUpstreamSlot()
  try {
    return await fn()
  } finally {
    releaseUpstreamSlot()
  }
}

// 进程内缓存（1h）+ singleflight：同一条正在解析时所有调用复用一个 Promise，不重复打上游。
const cache = new Map<string, { v: unknown; at: number }>()
const inflight = new Map<string, Promise<unknown>>()
function cached<T>(key: string, ttl = CACHE_TTL_MS): { hit: true; v: T } | { hit: false } {
  const h = cache.get(key)
  if (h && Date.now() - h.at < ttl) {
    cache.delete(key)
    cache.set(key, h)
    return { hit: true, v: h.v as T }
  }
  if (h) cache.delete(key)
  return { hit: false }
}
function put<T>(key: string, v: T): T {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now()
    for (const [cacheKey, entry] of cache) {
      if (now - entry.at >= CACHE_TTL_MS) cache.delete(cacheKey)
    }
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined
      if (!oldest) break
      cache.delete(oldest)
    }
  }
  cache.set(key, { v, at: Date.now() })
  return v
}

function singleflight<T>(key: string, load: () => Promise<T>): Promise<T> {
  const current = inflight.get(key) as Promise<T> | undefined
  if (current) return current
  const job = load()
  inflight.set(key, job)
  const clear = (): void => {
    if (inflight.get(key) === job) inflight.delete(key)
  }
  void job.then(clear, clear)
  return job
}

// 登录、退出或远端失效后轮换代次，避免稍后完成的旧请求重新污染新会话缓存。
export function clearXifanResolveCache(uid: number): void {
  sessionGenerations.set(uid, (sessionGenerations.get(uid) ?? 0) + 1)
  const prefix = `user:${uid}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key)
  }
}


export async function sourcePage(animeId: string, ep: number, uid: number | null, source?: number): Promise<string> {
  return nextPage(await upstream(() => nextXifan(uid).detail(Number(animeId))), ep, source)
}
export async function getPlaylist(animeId: string, ep: number, uid: number | null = null): Promise<Playlist> {
  const key = `${scope(uid)}:pl:${animeId}:${ep}`
  const hit = cached<Playlist>(key)
  if (hit.hit) return hit.v
  return singleflight(key, async () => {
    const detail = await upstream(() => nextXifan(uid).detail(Number(animeId)))
    const available = detail.sources.filter(s => s.episodes.some(e => e.number === ep))
    const lines = available.map(s => ({ source: s.id, name: s.name }))
    const eps = [...new Set(detail.sources.flatMap(s => s.episodes.map(e => e.number)))].sort((a, b) => a - b)
    if (!lines.length) return put(key, { title: detail.title, lines, first: null, eps })
    const fastKey = `${scope(uid)}:fast:${animeId}`
    const known = cached<number>(fastKey, 60 * 60_000)
    const preferred = known.hit && lines.some(l => l.source === known.v) ? known.v : lines[0].source
    let first = await resolveLine(animeId, ep, preferred, uid)
    const second = lines[1]
    if (!known.hit && first && second && first.kind === 'mp4' && canProxy(first.url)) {
      try {
        const alt = await resolveLine(animeId, ep, second.source, uid)
        if (alt && alt.kind === 'mp4' && canProxy(alt.url)) {
          const [one, two] = await Promise.all([measureThroughput(first.url, 3000), measureThroughput(alt.url, 3000)])
          if (two > one) first = alt
          if (one > 0 || two > 0) put(fastKey, first.source)
        }
      } catch (error) {
        console.error('[xifan:resolve] 备用线路测速失败，保留已解析线路：', error)
      }
    }
    return put(key, { title: detail.title, lines, first, eps })
  })
}
export async function resolveLine(animeId: string, ep: number, source: number, uid: number | null = null): Promise<PlayLine | null> {
  const key = `${scope(uid)}:ln:${animeId}:${ep}:${source}`
  const hit = cached<PlayLine>(key)
  if (hit.hit) return hit.v
  return singleflight(key, async () => {
    const media = await upstream(() => nextXifan(uid).playback(Number(animeId), ep, source))
    return put<PlayLine>(key, { source, url: media.url, kind: /\.m3u8(?:[?#]|$)/i.test(media.url) ? 'hls' : 'mp4', from: media.code })
  })
}
