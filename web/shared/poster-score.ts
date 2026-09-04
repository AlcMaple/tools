export interface PosterScoreSignals {
  favorite: number
  goodEpisodeCount: number
  notedEpisodeCount: number
  totalEpisodes?: number | null
  watchedEpisodes?: number
}

const FAVORITE_MAX = 6
const UNKNOWN_EPISODE_BASELINE = 12

function nonNegativeInt(value: number | undefined | null): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10
}

// 爱心给 0~6 分；好看集和有文字的备注各给最多 2 分。两个集数信号都按同一
// 个集数基准归一化，避免 100 集番只因集数多就天然占便宜。
export function calculatePosterScore(signals: PosterScoreSignals): number {
  const favorite = Math.min(FAVORITE_MAX, nonNegativeInt(signals.favorite))
  const totalEpisodes = nonNegativeInt(signals.totalEpisodes)
  const watchedEpisodes = nonNegativeInt(signals.watchedEpisodes)
  const goodEpisodeCount = nonNegativeInt(signals.goodEpisodeCount)
  const notedEpisodeCount = nonNegativeInt(signals.notedEpisodeCount)
  const episodeBase = totalEpisodes || Math.max(UNKNOWN_EPISODE_BASELINE, watchedEpisodes, goodEpisodeCount)
  const good = Math.min(goodEpisodeCount, episodeBase)
  const noted = Math.min(notedEpisodeCount, good)
  const goodSignal = (good / episodeBase) * 2
  const noteSignal = (noted / episodeBase) * 2
  return roundOne(Math.min(10, favorite + goodSignal + noteSignal))
}
