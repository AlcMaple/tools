import type { Source } from '../types/search'

/**
 * 搜索下载页的搜索历史 —— 纯本地（localStorage），**不进 WebDAV 同步**。
 * 和 bgmSearchHistory 同一套思路：历史是「这台设备上我搜过什么」的私货，
 * 跨设备同步只会把别的机器的噪音灌进来。
 *
 * 搜索缓存（search_cache）按 source 分桶，所以历史条目也带 source —— 同一
 * 关键词在不同源下是各自独立的一条，点历史就能恢复当时的源 + 命中对应缓存。
 */

const KEY = 'download_search_history'
const MAX = 15
const VALID_SOURCES: Source[] = ['Aowu', 'Xifan', 'Girigiri']

export interface DownloadHistoryEntry {
  keyword: string
  source: Source
  /** 最近一次搜索的时间戳，用于排序（最近优先） */
  ts: number
}

export function loadDownloadHistory(): DownloadHistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (e): e is DownloadHistoryEntry =>
          !!e &&
          typeof e.keyword === 'string' &&
          VALID_SOURCES.includes(e.source),
      )
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, MAX)
  } catch {
    return []
  }
}

function save(list: DownloadHistoryEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* ignore quota / serialization errors */
  }
}

/** 记录一次搜索：同 keyword+source 去重后置顶，超出 MAX 截断。 */
export function addDownloadHistory(keyword: string, source: Source): DownloadHistoryEntry[] {
  const kw = keyword.trim()
  if (!kw) return loadDownloadHistory()
  const prev = loadDownloadHistory().filter((e) => !(e.keyword === kw && e.source === source))
  const next = [{ keyword: kw, source, ts: Date.now() }, ...prev].slice(0, MAX)
  save(next)
  return next
}

export function removeDownloadHistory(keyword: string, source: Source): DownloadHistoryEntry[] {
  const next = loadDownloadHistory().filter((e) => !(e.keyword === keyword && e.source === source))
  save(next)
  return next
}

export function clearDownloadHistory(): DownloadHistoryEntry[] {
  save([])
  return []
}
