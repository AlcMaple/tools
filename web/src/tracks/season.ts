import type { Track } from '../api'
import { addedAtOf } from './TrackTimeline'

export type Season = 'winter' | 'spring' | 'summer' | 'autumn'
export type AirSeason = { year: number; season: Season | null; label: string; title: string }

const SEASON_NAME: Record<Season, string> = { winter: '冬', spring: '春', summer: '夏', autumn: '秋' }

// 按番剧季度惯例归季：1~3 月冬、4~6 春、7~9 夏、10~12 秋（2 月开播也算冬番）
export function airSeasonOf(airDate: string): AirSeason | null {
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(airDate)
  if (!m) return null
  const year = Number(m[1])
  const month = m[2] ? Number(m[2]) : 0
  if (!(month >= 1 && month <= 12)) return { year, season: null, label: String(year), title: `${year}年` }
  const season = (['winter', 'spring', 'summer', 'autumn'] as const)[Math.floor((month - 1) / 3)]
  const day = m[3] ? `${Number(m[3])}日` : ''
  return { year, season, label: SEASON_NAME[season], title: `${year}年${month}月${day}放送` }
}

export type TrackSort = 'added-desc' | 'added-asc' | 'air-asc' | 'air-desc'

export const SORT_OPTIONS: [TrackSort, string][] = [
  ['added-desc', '最新加入'],
  ['added-asc', '最早加入'],
  ['air-asc', '最早播出'],
  ['air-desc', '最新播出'],
]

// 播出排序精确到日：用户会按播出先后一部部追（如光之美少女系列），同季内也不能乱序。
// 缺日期的无论升降都沉底，同日或都缺日期时按加入时间稳定排列。
const dayKey = (d: string): string => (/^\d{4}(-\d{2}){0,2}/.exec(d)?.[0] ?? '')

export function sortTracks(list: Track[], sort: TrackSort): Track[] {
  const sign = sort.endsWith('desc') ? -1 : 1
  if (sort.startsWith('added')) return [...list].sort((a, b) => sign * (addedAtOf(a) - addedAtOf(b)))
  return [...list].sort((a, b) => {
    const da = dayKey(a.airDate)
    const db = dayKey(b.airDate)
    if (!da !== !db) return da ? -1 : 1
    if (da !== db) return sign * (da < db ? -1 : 1)
    return addedAtOf(a) - addedAtOf(b)
  })
}
