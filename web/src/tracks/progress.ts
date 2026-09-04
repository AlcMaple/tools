export function clampEpisode(episode: number, total: number | null): number {
  if (!Number.isFinite(episode)) return 0
  const value = Math.max(0, Math.floor(episode))
  if (total == null) return value
  const limit = Math.max(0, Math.floor(total))
  return Math.min(limit, value)
}

const UNKNOWN_PROGRESS_SCALE = 12
const UNKNOWN_PROGRESS_CAP = 99.5

export function parseEpisodeDraft(raw: string, total: number | null): number | null {
  const value = raw.trim()
  if (!/^\d+$/.test(value)) return null
  const episode = Number(value)
  return Number.isSafeInteger(episode) ? clampEpisode(episode, total) : null
}

export function episodeProgressPercent(episode: number, total: number | null): number {
  const value = clampEpisode(episode, total)
  if (total != null && total > 0) return Math.round((value / total) * 100)
  if (value <= 0) return 0
  // 连载总数未知时保留余量，集数越大每次新增的视觉增量越小。
  const raw = (value / (value + UNKNOWN_PROGRESS_SCALE)) * 100
  return Math.min(UNKNOWN_PROGRESS_CAP, Math.round(raw * 10) / 10)
}

export interface EpisodeProgressAnchor {
  episode: number
  percentage: number
}

export function episodeProgressPercentWithAnchor(
  episode: number,
  total: number | null,
  anchor: EpisodeProgressAnchor | null,
): number {
  // 总数补齐时沿用连载阶段的百分比，剩余空间只在后续集数里线性展开。
  if (anchor == null || total == null || total <= anchor.episode) return episodeProgressPercent(episode, total)
  const value = clampEpisode(episode, total)
  const start = Math.min(UNKNOWN_PROGRESS_CAP, Math.max(0, anchor.percentage))
  if (value <= anchor.episode) {
    const beforeRatio = anchor.episode > 0 ? value / anchor.episode : 0
    return Math.max(0, Math.round(start * beforeRatio * 10) / 10)
  }
  const afterRatio = (value - anchor.episode) / (total - anchor.episode)
  return Math.min(100, Math.max(0, Math.round((start + afterRatio * (100 - start)) * 10) / 10))
}

export function episodeFromPointer(
  clientX: number,
  left: number,
  width: number,
  total: number | null,
): number | null {
  if (total == null || total <= 0 || !Number.isFinite(width) || width <= 0) return null
  const ratio = Math.min(1, Math.max(0, (clientX - left) / width))
  return Math.round(ratio * total)
}

export function episodeFromDrag(
  clientX: number,
  startX: number,
  startEpisode: number,
  width: number,
  total: number | null,
): number | null {
  if (total == null || total <= 0 || !Number.isFinite(width) || width <= 0) return null
  const delta = ((clientX - startX) / width) * total
  return clampEpisode(Math.round(startEpisode + delta), total)
}
