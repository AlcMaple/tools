export const WATCH_EPISODES_KEY = 'mapletools-watch-episodes-v1'
const MAX_AGE = 30 * 24 * 60 * 60 * 1000
const MAX_ITEMS = 100

export interface WatchEpisodeContext {
  ownerId: number
  bgmId: number
  trackUpdatedAt: number
}

interface WatchEpisodeEntry extends WatchEpisodeContext {
  episode: number
  watchedAt: number
}

interface HistoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function entries(raw: string | null, now: number): WatchEpisodeEntry[] {
  if (!raw || raw.length > 64 * 1024) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const valid: WatchEpisodeEntry[] = []
    for (const item of parsed.slice(0, MAX_ITEMS)) {
      if (!item || typeof item !== 'object') continue
      const { ownerId, bgmId, trackUpdatedAt, episode, watchedAt } = item as Record<string, unknown>
      if (!positiveInteger(ownerId) || !positiveInteger(bgmId) || !positiveInteger(trackUpdatedAt) || !positiveInteger(episode) || !positiveInteger(watchedAt)) continue
      if (watchedAt > now + 60_000 || now - watchedAt >= MAX_AGE) continue
      valid.push({ ownerId, bgmId, trackUpdatedAt, episode, watchedAt })
    }
    return valid.sort((a, b) => b.watchedAt - a.watchedAt)
  } catch {
    return []
  }
}

export function recentWatchEpisode(storage: HistoryStorage, ownerId: number | null, track: { bgmId: number; updatedAt: number; totalEpisodes: number | null }, now = Date.now()): number | null {
  if (!positiveInteger(ownerId) || !positiveInteger(track.bgmId) || !positiveInteger(track.updatedAt)) return null
  const found = entries(storage.getItem(WATCH_EPISODES_KEY), now).find(item => item.ownerId === ownerId && item.bgmId === track.bgmId && item.trackUpdatedAt === track.updatedAt)
  if (!found || (track.totalEpisodes != null && found.episode > track.totalEpisodes)) return null
  return found.episode
}

export function rememberWatchEpisode(storage: HistoryStorage, context: WatchEpisodeContext | null, episode: number, now = Date.now()): void {
  if (!context || !positiveInteger(context.ownerId) || !positiveInteger(context.bgmId) || !positiveInteger(context.trackUpdatedAt) || !positiveInteger(episode)) return
  const previous = entries(storage.getItem(WATCH_EPISODES_KEY), now).filter(item => item.ownerId !== context.ownerId || item.bgmId !== context.bgmId)
  storage.setItem(WATCH_EPISODES_KEY, JSON.stringify([{ ...context, episode, watchedAt: now }, ...previous].slice(0, MAX_ITEMS)))
}
