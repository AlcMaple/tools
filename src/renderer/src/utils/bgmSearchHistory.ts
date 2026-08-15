import type { BgmSearchKind } from '../pages/AnimeInfo'

/**
 * BGM 搜索历史 —— 纯本地,**不进 WebDAV 同步**:历史是「这台设备上我搜过什么」的私货
 * 跨设备同步反而会把别的机器的噪音灌进来。
 *
 * 条目带 kind：同一关键词在动画 / 书籍下是两条独立历史；点一条会恢复原类目并重新
 * 查询本地数据，不会自动转成在线搜索。
 */

const KEY = 'bgm_search_history'
const MAX = 15

export interface BgmHistoryEntry {
  keyword: string
  kind: BgmSearchKind
  /** 最近一次搜索的时间戳,用于排序(最近优先) */
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

/** 记录一次搜索:同 keyword+kind 去重后置顶,超出上限截断。 */
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
