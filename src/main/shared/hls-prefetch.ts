// HLS 分片的滑动窗口预取 —— 只服务 media-proxy 的分片分支。
//
// **「HLS 分片」和「多线程分段下载」不是一回事**(别被直觉带偏):hls.js 的默认 loader 是
// 单连接、一片接一片顺序取,不会开多条连接去抢同一段时间窗口;而下载路径本来就是 8 路并发抓 .ts。
// 下载快、播放卡,是同一份资源两条路径不对称造成的,不是站点只对播放限速。
//
// 做法:代理重写播放列表时把分片顺序记下来,hls.js 来要第 N 片时,除了回它这一片,再并发把后面
// 几片提前抓进内存 —— 等它顺序要到时直接从内存回,把单连接的往返延迟摊掉。
//
// 分片是独立小文件,**不需要按字节区间切**(那是 mp4 直链那条路的事,见 media-cache.ts)。
import { net } from 'electron'

/** 每次命中往前预取多少片。分片多为 5~10s,6 片约等于半分钟缓冲。 */
const PREFETCH_AHEAD = 6
/** 与下载路径的并发同口径,**别再往上加** —— 同源并发过高是封 IP 的快车道。 */
const MAX_CONCURRENCY = 8
/** 内存缓存上限,超了从最旧的开始丢。 */
const MAX_CACHE_BYTES = 192 * 1024 * 1024
/** 单片超过这个大小就不进缓存(异常 / 被投毒的响应)。 */
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024

interface Entry {
  /** 抓取中的 promise,完成后 bytes 落位;失败为 null,调用方退回直连。 */
  p: Promise<Uint8Array | null>
  bytes: Uint8Array | null
}

/** 当前播放列表的分片顺序(原始绝对地址)。 */
let order: string[] = []
let indexOf = new Map<string, number>()
let listKey = ''
const cache = new Map<string, Entry>()
let cacheBytes = 0
let running = 0
const queue: (() => void)[] = []

function reset(): void {
  order = []
  indexOf = new Map()
  cache.clear()
  cacheBytes = 0
}

/** 换集/换源/退出播放页时调用,与 media-cache 一起收摊。 */
export function disposeHlsPrefetch(): void {
  listKey = ''
  reset()
}

/**
 * 记住一份播放列表的分片顺序。同一个列表重复解析(hls.js 会周期性重拉)不清缓存;
 * 换了列表(换集/换线路/换清晰度)才整份丢掉 —— 旧分片留着只会白占内存。
 */
export function rememberPlaylist(playlistUrl: string, segments: string[]): void {
  if (segments.length === 0) return
  if (listKey !== playlistUrl) {
    listKey = playlistUrl
    reset()
  }
  order = segments
  indexOf = new Map(segments.map((u, i) => [u, i]))
}

function evictIfNeeded(): void {
  // Map 保持插入序,从最旧的开始丢(顺序播放下最旧的就是已经播过的)
  for (const [url, e] of cache) {
    if (cacheBytes <= MAX_CACHE_BYTES) break
    if (!e.bytes) continue // 抓取中的不动
    cacheBytes -= e.bytes.byteLength
    cache.delete(url)
  }
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => queue.push(resolve))
  }
  running++
  try {
    return await fn()
  } finally {
    running--
    queue.shift()?.()
  }
}

function fetchSegment(url: string, headers: Record<string, string>): Entry {
  const existing = cache.get(url)
  if (existing) return existing
  const entry: Entry = { bytes: null, p: Promise.resolve(null) }
  entry.p = withSlot(async () => {
    try {
      const res = await net.fetch(url, { headers, redirect: 'follow' })
      if (!res.ok) return null
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (declared > MAX_SEGMENT_BYTES) return null
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > MAX_SEGMENT_BYTES) return null
      // 预取失败不重试:失败要么是链接过期(重取列表就好),要么是站点在限速 ——
      // 都不该由预取层去加压(红线)。
      entry.bytes = buf
      cacheBytes += buf.byteLength
      evictIfNeeded()
      return buf
    } catch {
      return null
    }
  })
  // 失败的条目不留在缓存里,否则后面每次都命中一个 null
  void entry.p.then((b) => { if (!b) cache.delete(url) })
  cache.set(url, entry)
  return entry
}

/** hls.js 要到第 N 片时,把 N+1..N+PREFETCH_AHEAD 提前抓起来(已在缓存/抓取中的跳过)。 */
export function prefetchAround(url: string, headers: Record<string, string>): void {
  const i = indexOf.get(url)
  if (i === undefined) return
  for (let n = i + 1; n <= i + PREFETCH_AHEAD && n < order.length; n++) {
    const next = order[n]
    if (!cache.has(next)) fetchSegment(next, headers)
  }
}

/**
 * 试着用预取缓存回一个分片。返回 null = 不是已知分片 / 预取失败,调用方走直连。
 * 命中抓取中的条目时会等它完成 —— 那也比自己再开一条连接重抓一遍快。
 */
export async function tryServeSegment(
  url: string,
  headers: Record<string, string>,
): Promise<Uint8Array | null> {
  if (!indexOf.has(url)) return null
  const entry = cache.get(url) ?? fetchSegment(url, headers)
  const bytes = entry.bytes ?? (await entry.p)
  if (!bytes) return null
  prefetchAround(url, headers)
  return bytes
}
