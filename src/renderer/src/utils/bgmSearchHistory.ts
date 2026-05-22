import type { BgmSearchKind } from '../pages/AnimeInfo'

/**
 * BGM 搜索历史 —— 纯本地（localStorage），**不进 WebDAV 同步**。
 * 历史是「这台设备上我搜过什么」的私货，跨设备同步反而会把别的机器的
 * 噪音灌进来，所以刻意不挂到 anime_tracks.json 那套可移植 JSON 上。
 *
 * 和搜索缓存（search_cache_bgm，按 cat 分桶）配套：历史里点一条就直接
 * 命中缓存，不用再发网络请求。所以历史条目也带 kind —— 同一关键词在
 * 动画 / 漫画小说两个类目下是两条独立历史（缓存也是分桶的）。
 */

const KEY = 'bgm_search_history'
const MAX = 15

export interface BgmHistoryEntry {
  keyword: string
  kind: BgmSearchKind
  /** 最近一次搜索的时间戳，用于排序（最近优先） */
  ts: number
}

export function loadBgmHistory(): BgmHistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (e): e is BgmHistoryEntry =>
          !!e &&
          typeof e.keyword === 'string' &&
          (e.kind === 'anime' || e.kind === 'book'),
      )
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, MAX)
  } catch {
    return []
  }
}

function save(list: BgmHistoryEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* ignore quota / serialization errors */
  }
}

/** 记录一次搜索：同 keyword+kind 去重后置顶，超出 MAX 截断。 */
export function addBgmHistory(keyword: string, kind: BgmSearchKind): BgmHistoryEntry[] {
  const kw = keyword.trim()
  if (!kw) return loadBgmHistory()
  const prev = loadBgmHistory().filter((e) => !(e.keyword === kw && e.kind === kind))
  const next = [{ keyword: kw, kind, ts: Date.now() }, ...prev].slice(0, MAX)
  save(next)
  return next
}

export function removeBgmHistory(keyword: string, kind: BgmSearchKind): BgmHistoryEntry[] {
  const next = loadBgmHistory().filter((e) => !(e.keyword === keyword && e.kind === kind))
  save(next)
  return next
}

export function clearBgmHistory(): BgmHistoryEntry[] {
  save([])
  return []
}
