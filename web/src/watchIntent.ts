import type { CalendarItem } from './api'

const KEY = 'mt-watch-after-login'
const TTL = 30 * 60_000
type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function sessionStorage(): IntentStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}

function validAnime(value: unknown): value is CalendarItem {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return Number.isSafeInteger(v.id) && Number(v.id) > 0
    && typeof v.name === 'string' && v.name.length <= 200
    && typeof v.name_cn === 'string' && v.name_cn.length <= 200 && !!(v.name.trim() || v.name_cn.trim())
    && typeof v.airDate === 'string' && v.airDate.length <= 10
    && Number.isSafeInteger(v.episodes) && Number(v.episodes) >= 0 && Number(v.episodes) <= 10_000
    && typeof v.score === 'number' && Number.isFinite(v.score) && v.score >= 0 && v.score <= 10
}

export function clearWatchIntent(storage = sessionStorage()): void {
  try { storage?.removeItem(KEY) } catch { /* 禁用存储时仍由弹窗内存状态接续 */ }
}

export function rememberWatchIntent(item: CalendarItem, storage = sessionStorage(), now = Date.now()): CalendarItem | null {
  if (!validAnime(item)) return null
  // 只留下公开条目，不把封面地址、源站地址或认证信息带过登录跳转
  const anime: CalendarItem = { id: item.id, name: item.name, name_cn: item.name_cn, airDate: item.airDate, episodes: item.episodes, score: item.score, url: '', cover: '' }
  try { storage?.setItem(KEY, JSON.stringify({ anime, expiresAt: now + TTL })) } catch { /* 当前页登录仍可用内存状态 */ }
  return anime
}

export function readWatchIntent(storage = sessionStorage(), now = Date.now()): CalendarItem | null {
  try {
    const text = storage?.getItem(KEY)
    if (!text) return null
    const value: unknown = text.length <= 4096 ? JSON.parse(text) : null
    if (value && typeof value === 'object') {
      const v = value as { anime?: unknown; expiresAt?: unknown }
      if (validAnime(v.anime) && typeof v.expiresAt === 'number' && v.expiresAt > now && v.expiresAt <= now + TTL) {
        return { id: v.anime.id, name: v.anime.name, name_cn: v.anime.name_cn, airDate: v.anime.airDate, episodes: v.anime.episodes, score: v.anime.score, url: '', cover: '' }
      }
    }
  } catch { /* 损坏或被禁用的存储不恢复观看动作 */ }
  clearWatchIntent(storage)
  return null
}
