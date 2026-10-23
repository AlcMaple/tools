import { proxyReady } from '../http'

export const BASE_URL = 'https://ani.girigirilove.com'
export const API_URL = 'https://m3u8.girigirilove.com/api.php/'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MAX_BYTES = 2 * 1024 * 1024
const CF_MARKERS = ['cf-browser-verification', '/cdn-cgi/challenge-platform', 'Attention Required! | Cloudflare', 'cf-error-details']
type ApiPath = 'Vod/get_detail' | 'Vod/get_list' | 'App2/weekList'

export class GirigiriError extends Error {
  constructor(message: string, readonly code: string, readonly upstreamStatus?: number) {
    super(message)
    this.name = 'GirigiriError'
  }
}

export function isGirigiriId(value: string): boolean {
  return /^GV[1-9]\d*$/i.test(value) && Number.isSafeInteger(Number(value.slice(2)))
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function invalid(message: string): never {
  throw new GirigiriError(`Girigiri ${message}`, 'GIRIGIRI_RESPONSE_INVALID')
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function mediaUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

export interface GirigiriEpisode { number: number | null; name: string; episodeIndex: number; url: string }
export interface GirigiriSource { source: number; sourceIndex: number; name: string; episodes: GirigiriEpisode[] }
export interface GirigiriDetail { id: string; title: string; sources: GirigiriSource[] }

function episodeNumber(name: string, count: number): number | null {
  const match = name.match(/^(?:第\s*)?(\d+)\s*(?:[集话話期])?$/u)
  if (match) return positiveInt(match[1])
  // 单集电影常标「正片」，但 PV / OVA 等特殊条目不冒充正片集号。
  return count === 1 && /^(?:正片|全片|全集|HD|BD|高清|超清|1080P|720P|剧场版|劇場版)$/i.test(name) ? 1 : null
}

export function parseDetail(value: unknown, id: string): GirigiriDetail {
  const data = record(value)
  if (!data || positiveInt(data.vod_id) !== Number(id.slice(2)) || !text(data.vod_name)) invalid('详情数据不完整或编号不匹配')
  if (typeof data.vod_play_from !== 'string' || typeof data.vod_play_url !== 'string') invalid('详情缺少播放列表')
  const names = data.vod_play_from.split('$$$'), groups = data.vod_play_url.split('$$$')
  if (names.length !== groups.length) invalid('线路与播放列表数量不一致')
  const sources: GirigiriSource[] = []
  for (let i = 0; i < names.length; i++) {
    const code = names[i].trim()
    if (!code || !groups[i].trim()) continue
    const entries = groups[i].split('#').flatMap((entry) => {
      const split = entry.indexOf('$')
      const name = (split < 0 ? entry : entry.slice(0, split)).trim()
      const url = (split < 0 ? entry : entry.slice(split + 1)).trim()
      return name && url ? [{ name, url }] : []
    })
    if (!entries.length) continue
    // 新站路由使用过滤空线路后的零基索引；集号来自标签，绝不拿数组位置冒充集号。
    const sourceIndex = sources.length
    sources.push({ source: sourceIndex + 1, sourceIndex,
      name: code === 'cht' ? '繁中' : code === 'chs' ? '简中' : code,
      episodes: entries.map((entry, episodeIndex) => ({ name: entry.name, number: episodeNumber(entry.name, entries.length), episodeIndex, url: mediaUrl(entry.url) })),
    })
  }
  return { id: id.toUpperCase(), title: text(data.vod_name), sources }
}

export function sourcePageUrl(detail: GirigiriDetail, ep: number): string {
  for (const source of detail.sources) {
    const episode = source.episodes.find((item) => item.number === ep)
    if (episode) {
      const query = new URLSearchParams({ sourceIndex: String(source.sourceIndex), episodeIndex: String(episode.episodeIndex) })
      return `${BASE_URL}/play/${detail.id.slice(2)}?${query}`
    }
  }
  throw new GirigiriError(`Girigiri 没有第 ${ep} 集，请选择其他集数`, 'GIRIGIRI_EPISODE_NOT_FOUND')
}

const pending = new Map<string, Promise<unknown>>()
const cache = new Map<string, { value: unknown; expires: number }>()
let queue = Promise.resolve(), lastStartedAt = 0

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const job = queue.then(async () => {
    const gap = 1000 + Math.floor(Math.random() * 301) - (Date.now() - lastStartedAt)
    if (gap > 0) await new Promise<void>((resolve) => setTimeout(resolve, gap))
    lastStartedAt = Date.now()
    return fn()
  })
  queue = job.then(() => undefined, () => undefined)
  return job
}

async function readBody(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel()
    invalid('响应超过大小限制')
  }
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_BYTES) { await reader.cancel(); invalid('响应超过大小限制') }
      chunks.push(next.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { reader.releaseLock() }
}

export async function requestApi(path: ApiPath, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(path, API_URL)
  url.search = new URLSearchParams(params).toString()
  await proxyReady
  // 新站公开 API 无需验证码或用户 cookie；HTTP / 业务失败直接上抛，不重试、不探活。
  return schedule(async () => {
    const response = await fetch(url.href, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: `${BASE_URL}/` },
      redirect: 'manual', signal: AbortSignal.timeout(15000),
    })
    const body = await readBody(response)
    let data: Record<string, unknown> | null = null
    try { data = record(JSON.parse(body)) } catch { /* 非 JSON 在下面报协议错误，不当作空结果。 */ }
    if (CF_MARKERS.some((marker) => body.includes(marker))) throw new GirigiriError('Girigiri 被 Cloudflare 拦截，请稍后再试', 'GIRIGIRI_BLOCKED', response.status)
    if (!response.ok) {
      const message = text(data?.msg) || `请求失败：服务器返回 HTTP ${response.status}`
      throw new GirigiriError(`Girigiri ${message}`, String(data?.code ?? `UPSTREAM_${response.status}`), response.status)
    }
    if (!data) invalid('接口返回了非 JSON 数据，源站协议可能已调整')
    if (Number(data.code) !== 1 && Number(data.code) !== 200) throw new GirigiriError(`Girigiri ${text(data.msg) || '接口返回了未知错误'}`, String(data.code ?? 'GIRIGIRI_API_ERROR'))
    if (!Object.hasOwn(data, 'info')) invalid('接口缺少 info 数据')
    return data.info
  })
}

async function memo<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value as T
  const inflight = pending.get(key)
  if (inflight) return inflight as Promise<T>
  const task = load().then((value) => {
    for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key)
    if (cache.size >= 500) cache.delete(cache.keys().next().value as string)
    cache.set(key, { value, expires: Date.now() + ttl })
    return value
  })
  pending.set(key, task)
  try { return await task } finally { pending.delete(key) }
}

export function getDetail(id: string): Promise<GirigiriDetail> {
  if (!isGirigiriId(id)) throw new GirigiriError('girigiriId 不合法', 'GIRIGIRI_ID_INVALID')
  const canonical = id.toUpperCase()
  return memo(`detail:${canonical}`, 30000, async () => parseDetail(await requestApi('Vod/get_detail', { vod_id: canonical.slice(2), user_id: '' }), canonical))
}

export interface GirigiriSearchHit { girigiriId: string; girigiriName: string; cover: string; episode: string; year: string; area: string }

function parseHit(value: unknown): GirigiriSearchHit {
  const item = record(value), id = positiveInt(item?.vod_id)
  if (!item || !id || !text(item.vod_name)) invalid('搜索结果条目不完整')
  const rawCover = text(item.vod_pic)
  return { girigiriId: `GV${id}`, girigiriName: text(item.vod_name),
    cover: mediaUrl(rawCover.startsWith('upload/') ? `https://jpg.girigirilove.net/${rawCover}` : rawCover),
    episode: text(item.vod_remarks), year: String(item.vod_year ?? ''), area: text(item.vod_area),
  }
}

export async function searchAll(keyword: string): Promise<GirigiriSearchHit[]> {
  const results = new Map<string, GirigiriSearchHit>()
  let offset = 0
  for (let page = 0; page < 20; page++) {
    const info = record(await requestApi('Vod/get_list', { vod_name: keyword, offset: String(offset), limit: '24' }))
    if (!info || !Array.isArray(info.rows) || (typeof info.total !== 'number' && typeof info.total !== 'string')) invalid('搜索分页结构不完整')
    const total = Number(info.total)
    if (!Number.isSafeInteger(total) || total < 0) invalid('搜索总数不合法')
    const hits = info.rows.map(parseHit)
    if (!hits.length && offset < total) invalid('搜索分页提前结束')
    const previousSize = results.size
    for (const hit of hits) results.set(hit.girigiriId, hit)
    offset += hits.length
    if (offset >= total) return [...results.values()]
    if (results.size === previousSize) invalid('搜索分页重复，已停止请求')
  }
  throw new GirigiriError('Girigiri 搜索结果过多，请缩短范围后重新搜索', 'GIRIGIRI_SEARCH_LIMIT')
}

export interface WeekItem { girigiriId: string; name: string; day: number; remarks: string }

export function getWeekday(): Promise<WeekItem[]> {
  return memo('weekday', 6 * 60 * 60 * 1000, async () => {
    const data = await requestApi('App2/weekList')
    if (!Array.isArray(data)) invalid('周表结构不完整')
    return data.flatMap((value) => {
      const day = record(value), number = positiveInt(day?.week)
      if (!day || !number || number > 7 || !Array.isArray(day.video)) invalid('周表日期或条目不完整')
      return day.video.map((value) => {
        const item = parseHit(value)
        return { girigiriId: item.girigiriId, name: item.girigiriName, day: number, remarks: text(record(value)?.vod_time) }
      })
    })
  })
}
