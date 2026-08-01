// 页面级数据的持久缓存 —— App.tsx 按路由整页换组件（不是保留挂载只是隐藏），切一次 tab
// 等于 CalendarPage / TracksPage 整个重新挂载。用 localStorage 而不是纯内存 Map：这样刷新页面、
// 开新标签页也能秒开上次的数据，不用每次都先等一轮网络。
//
// 两种用法：
//   - cacheGet(key, maxAgeMs)：过期就当没有，调用方该发请求就发（周历用这个——BGM 是外部接口，
//     缓存没过期就没必要发请求，跟桌面端一样信 14 天的服务端缓存窗口，别把节流的意义拉回原地）。
//   - cachePeek(key)：不看新鲜度，有就给，配合「先秒开缓存、后台再悄悄校验」用（追番用这个——
//     `/api/tracks` 是自己的后端，没有限流顾虑，正确性比省请求更重要）。
const PREFIX = 'mt_cache:'

interface Entry<T> {
  data: T
  at: number
}

function read<T>(key: string): Entry<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as Entry<T>) : null
  } catch {
    return null // 隐私模式 / 存储被禁 / 内容损坏 —— 缓存只是优化，读不到就当没缓存
  }
}

export function cacheGet<T>(key: string, maxAgeMs: number): T | undefined {
  const hit = read<T>(key)
  if (!hit || Date.now() - hit.at > maxAgeMs) return undefined
  return hit.data
}

export function cachePeek<T>(key: string): T | undefined {
  return read<T>(key)?.data
}

export function cacheSet<T>(key: string, data: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ data, at: Date.now() } satisfies Entry<T>))
  } catch {
    /* 存储满了也没关系，缓存只是优化 */
  }
}

export function cacheClear(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    /* ignore */
  }
}
