export function clampEpisode(episode: number, total: number | null): number {
  if (!Number.isFinite(episode)) return 0
  const value = Math.max(0, Math.floor(episode))
  if (total == null) return value
  const limit = Math.max(0, Math.floor(total))
  return Math.min(limit, value)
}

export function parseEpisodeDraft(raw: string, total: number | null): number | null {
  const value = raw.trim()
  if (!/^\d+$/.test(value)) return null
  const episode = Number(value)
  return Number.isSafeInteger(episode) ? clampEpisode(episode, total) : null
}

export function episodeProgressPercent(episode: number, total: number | null): number {
  const value = clampEpisode(episode, total)
  if (total != null && total > 0) return Math.round((value / total) * 100)
  return value > 0 ? Math.min(100, 8 + value * 6) : 0
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
