// 追番数据的「秒开缓存 + 后台校验」—— 缓存只负责首屏立即可见，账号服务器才是跨设备的
// 唯一事实源。真实请求回来后整份覆盖缓存，不能拿 localStorage 的 updatedAt 反过来压服务器：
// 旧部署、设备时钟或中途关闭页面留下的未来时间戳，会让一台设备永久停在旧状态。
import {
  fetchGirigiriBindings,
  fetchTracks,
  fetchXifanBindings,
  type GirigiriBinding,
  type Track,
  type XifanBinding,
} from './api'
import { cachePeek, cacheSet } from './dataCache'

const tracksKey = (username: string): string => `tracks:${username}`
const bindingsKey = (username: string): string => `xifanBindings:${username}`
const girigiriBindingsKey = (username: string): string => `girigiriBindings:${username}`

// 页面显示缓存后，用户可能在后台 GET 返回前立即改进度 / 状态。用当前会话内的递增号识别
// 这种真实竞态；它不落 localStorage，因此历史旧缓存永远没有资格阻止服务器纠正数据。
const mutationVersions = new Map<string, number>()

export function markTracksMutation(username: string): void {
  mutationVersions.set(username, (mutationVersions.get(username) ?? 0) + 1)
}

/** 立刻用缓存喂一次 onData（如果有），随后后台拉最新数据并整份覆盖缓存与页面。
 *  返回取消函数——组件卸载后不再套用迟到的响应。 */
export function loadTracks(username: string, onData: (ts: Track[]) => void): () => void {
  const key = tracksKey(username)
  const cached = cachePeek<Track[]>(key)
  if (cached) onData(cached)

  let cancelled = false
  const mutationVersion = mutationVersions.get(username) ?? 0
  fetchTracks()
    .then((server) => {
      // GET 发出后若本页已有写操作，它拿到的可能是写入前快照；等 PUT/DELETE 自己收口，
      // 不让这份迟到的读结果把用户刚点的状态盖回去。
      if (cancelled || (mutationVersions.get(username) ?? 0) !== mutationVersion) return
      cacheSet(key, server)
      onData(server)
    })
    .catch(() => undefined) // 后台校验失败不打扰——缓存的数据还能接着用
  return () => {
    cancelled = true
  }
}

/** 绑定关系没有跨端冲突的场景（建绑定是一次性动作），后台校验直接整份覆盖即可。 */
export function loadBindings(
  username: string,
  onData: (b: Record<number, XifanBinding>) => void
): () => void {
  const key = bindingsKey(username)
  const cached = cachePeek<Record<number, XifanBinding>>(key)
  if (cached) onData(cached)

  let cancelled = false
  fetchXifanBindings()
    .then((b) => {
      if (cancelled) return
      cacheSet(key, b)
      onData(b)
    })
    .catch(() => undefined)
  return () => {
    cancelled = true
  }
}

/** 乐观更新落地后，把最新状态直接写回缓存——不用等下次后台校验才追上。 */
export function saveTracksCache(username: string, ts: Track[]): void {
  cacheSet(tracksKey(username), ts)
}
export function saveBindingsCache(username: string, b: Record<number, XifanBinding>): void {
  cacheSet(bindingsKey(username), b)
}

export function loadGirigiriBindings(
  username: string,
  onData: (b: Record<number, GirigiriBinding>) => void,
): () => void {
  const key = girigiriBindingsKey(username)
  const cached = cachePeek<Record<number, GirigiriBinding>>(key)
  if (cached) onData(cached)

  let cancelled = false
  fetchGirigiriBindings()
    .then((bindings) => {
      if (cancelled) return
      cacheSet(key, bindings)
      onData(bindings)
    })
    .catch(() => undefined)
  return () => {
    cancelled = true
  }
}

export function saveGirigiriBindingsCache(username: string, b: Record<number, GirigiriBinding>): void {
  cacheSet(girigiriBindingsKey(username), b)
}
