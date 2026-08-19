/**
 * 嗷呜的视频地址解析。对着加密的 /api/site/secure 走两步:
 *   1. bundle(bundle_page="play", id, source_id, episode) → { play_token: { token } }
 *   2. play(id, token=play_token)                          → { url: 签名后的 CDN mp4 }
 *
 * 解出来的是签名 CDN 直链,支持 HTTP Range,有效期几个小时 —— 足够下游分片下载跑完。
 *
 * `watchUrl` 形如 `${BASE_URL}/w/{idOrToken}#s={src}&ep={ep}`:hash 带 source_id 和集数
 * 路径尾部带 id。现在路径里放的是数字 video id,老队列里可能还是不透明的 play_token
 * 那种情况先 route 一次换回来。
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

  // hash 带 `s=...&ep=...`;URL 解析出来的 hash 是以 `#` 开头的整串。
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
    // 老格式:尾部是不透明的 play token,先 route 一次。
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

// ── 已解析地址的缓存(跨重启保留) ──────────────────────────────────────────
// 签名 CDN 直链实测至少 24h 内有效。下载流程和「复制 mp4 链接」都会拿**同一个** watch URL
// 来解析 —— 没有缓存的话每次都要打两趟加密接口(bundle + play,来回 3~5s)。
//
// 有了缓存:下载开始时解析过的地址,再点「复制链接」就是秒回;下一集在前一集下载时被解析过
// 轮到它下载时也直接命中。同一个 watch URL 的并发调用会合并到同一个 promise 上。
//
// 存成 userData 下的一个 JSON map,首次访问时惰性加载(这样模块可以在 app ready 之前被 import)
// 写入防抖 1s 合并。加载时过滤掉超过 24h 的条目;文件损坏就当空缓存重来,不算失败。
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
    // 缓存损坏或 app 未就绪 —— 放过,内存里的表保持为空。
  }
}

function persist(): void {
  if (!cacheFile) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      // 落盘时顺手剔除过期项 —— 否则常驻不重启的会话里过期条目只增不减
      // (重启时 ensureLoaded 会按 TTL 过滤,但长开的进程没这个机会)。
      const now = Date.now()
      const obj: Record<string, CacheEntry> = {}
      for (const [k, v] of urlCache) {
        if (now - v.resolvedAt >= CACHE_TTL_MS) { urlCache.delete(k); continue }
        obj[k] = v
      }
      writeFileSync(cacheFile!, JSON.stringify(obj))
    } catch {
      // 落盘失败不致命 —— 下次会话重新解析一遍就是了。
    }
  }, PERSIST_DEBOUNCE_MS)
}

/** Resolve a watch URL to its signed CDN mp4 URL. Cached (TTL 24h, on disk) + coalesced. */
export async function resolveAowuMp4(watchUrl: string, forceRefresh = false): Promise<string> {
  ensureLoaded()
  const cached = urlCache.get(watchUrl)
  if (!forceRefresh && cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return cached.url
  }

  // 强刷与普通解析分开合并；失败时旧缓存仍保留，只有拿到新地址才原子覆盖。
  const inflightKey = `${watchUrl}\n${forceRefresh ? 'refresh' : 'normal'}`
  const existing = inflight.get(inflightKey)
  if (existing) return existing

  const p = (async (): Promise<string> => {
    try {
      const url = await computeAowuMp4(watchUrl)
      urlCache.set(watchUrl, { url, resolvedAt: Date.now() })
      persist()
      return url
    } finally {
      inflight.delete(inflightKey)
    }
  })()
  inflight.set(inflightKey, p)
  return p
}

/**
 * Construct the watch URL fed to {@link resolveAowuMp4}. Pure formatter — kept
 * 传下去,让 IPC handler 只构造一次 URL 再往下透传。
 */
export function buildAowuWatchUrl(animeToken: string, sourceId: number, epNum: number): string {
  return `${BASE_URL}/w/${animeToken}#s=${sourceId}&ep=${epNum}`
}
