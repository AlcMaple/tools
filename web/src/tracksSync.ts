// 追番数据的「秒开缓存 + 后台校验」—— 手机改完在电脑上看、电脑改完在手机上看，都得最终一致，
// 但又不想每次切页面都干等一轮网络。策略：有缓存就立刻用缓存渲染，同时背着用户发一次真实请求，
// 回来后按每条记录的 updatedAt 合并（谁更新谁赢），再刷新一次界面 + 写回缓存。
// bgmId 级别整条覆盖，不做字段级合并——一条追番记录不会真的被两台设备同时各改一半。
import { fetchTracks, fetchXifanBindings, type Track, type XifanBinding } from './api'
import { cachePeek, cacheSet } from './dataCache'

const tracksKey = (username: string): string => `tracks:${username}`
const bindingsKey = (username: string): string => `xifanBindings:${username}`

function mergeByUpdatedAt(server: Track[], local: Track[] | undefined): Track[] {
  if (!local || local.length === 0) return server
  const localMap = new Map(local.map((t) => [t.bgmId, t]))
  // 以 server 的 id 集合为准（新增/删除都在服务端已经生效）；同一条谁 updatedAt 更新就用谁的内容，
  // 这样本机一个刚落地但服务端时钟还没反应过来的乐观更新，不会被这次后台校验盖回旧值。
  return server.map((s) => {
    const l = localMap.get(s.bgmId)
    return l && l.updatedAt > s.updatedAt ? l : s
  })
}

/** 立刻用缓存喂一次 onData（如果有），随后后台拉最新数据、合并、再喂一次并写回缓存。
 *  返回取消函数——组件卸载后不再套用迟到的响应。 */
export function loadTracks(username: string, onData: (ts: Track[]) => void): () => void {
  const key = tracksKey(username)
  const cached = cachePeek<Track[]>(key)
  if (cached) onData(cached)

  let cancelled = false
  fetchTracks()
    .then((server) => {
      if (cancelled) return
      const merged = mergeByUpdatedAt(server, cachePeek<Track[]>(key))
      cacheSet(key, merged)
      onData(merged)
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
