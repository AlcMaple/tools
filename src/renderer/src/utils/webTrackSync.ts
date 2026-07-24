import {
  normalizeTracks,
  type AnimeStatus,
  type AnimeTrack,
} from '../stores/animeTrackStore'

interface WebSyncTrack {
  bgmId: number
  status: 'watching' | 'plan' | 'done'
  episode: number
  totalEpisodes: number | null
  title: string
  titleCn: string
  cover: string
  airWeekday: number
  airDate: string
  bgmTags: string[]
  userTags: string[]
  aliases: string[]
  updatedAt: number
  extra: Record<string, unknown>
}

const APP_STATUSES: ReadonlyArray<AnimeStatus> = ['plan', 'watching', 'completed', 'considering']

function webStatus(status: AnimeStatus): WebSyncTrack['status'] {
  if (status === 'completed') return 'done'
  if (status === 'considering') return 'plan'
  return status
}

function appStatus(status: unknown): AnimeStatus {
  if (status === 'done') return 'completed'
  if (status === 'watching') return 'watching'
  return 'plan'
}

function weekdayFromAirDate(airDate: string | undefined): number {
  const match = airDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return 0
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return day === 0 ? 7 : day
}

/**
 * app 富记录 → web 瘦列 + extra。
 *
 * 公共字段单独投影，让网页可以正常筛选和编辑；网页不认识的字段全部进 extra。
 * `appStatus` 专门保住「观望」：网页把它展示成「想看」，若网页没有改状态，拉回
 * app 时仍恢复成观望；网页真改成在追/看完后则以网页的新状态为准。
 */
export function toWebSyncTracks(tracks: AnimeTrack[]): WebSyncTrack[] {
  return tracks.map((track) => ({
    bgmId: track.bgmId,
    status: webStatus(track.status),
    episode: track.episode,
    totalEpisodes: track.totalEpisodes ?? null,
    title: track.title,
    titleCn: track.titleCn ?? '',
    cover: track.cover ?? '',
    // app 没单独存每周放送日；首播日期的星期就是正常周播日，足够让从 app
    // 新上传的记录立即进入网页版「今天更新」分组。无日期时保持 0（未知）。
    airWeekday: weekdayFromAirDate(track.airDate),
    airDate: track.airDate ?? '',
    bgmTags: track.bgmTags,
    userTags: track.userTags,
    aliases: track.aliases,
    updatedAt: new Date(track.updatedAt).getTime() || Date.now(),
    extra: {
      appStatus: track.status,
      subjectType: track.subjectType,
      bindings: track.bindings,
      notes: track.notes,
      favorite: track.favorite,
      observeCount: track.observeCount,
      novelVolume: track.novelVolume,
      novelChapter: track.novelChapter,
      goodEpisodes: track.goodEpisodes,
      goodEpisodeNotes: track.goodEpisodeNotes,
      startedAt: track.startedAt,
    },
  }))
}

/**
 * web 同步记录 → app AnimeTrack。
 *
 * 先把 extra 展开，再用公共字段覆盖，确保网页对进度、标签、标题等字段的修改
 * 能回到 app；最后统一走 store 的 normalize，老记录和缺字段记录都安全补默认。
 */
export function fromWebSyncTracks(input: unknown): AnimeTrack[] {
  if (!Array.isArray(input)) return []
  const projected = input.map((value) => {
    if (!value || typeof value !== 'object') return value
    const row = value as Record<string, unknown>
    const extra = row.extra && typeof row.extra === 'object' && !Array.isArray(row.extra)
      ? row.extra as Record<string, unknown>
      : {}
    const preserved = APP_STATUSES.includes(extra.appStatus as AnimeStatus)
      ? extra.appStatus as AnimeStatus
      : null
    const status = preserved && webStatus(preserved) === row.status
      ? preserved
      : appStatus(row.status)
    const updatedAtMs = Number(row.updatedAt)
    return {
      ...extra,
      bgmId: Number(row.bgmId),
      status,
      episode: Number(row.episode) || 0,
      totalEpisodes: row.totalEpisodes == null ? undefined : Number(row.totalEpisodes),
      title: typeof row.title === 'string' ? row.title : '',
      titleCn: typeof row.titleCn === 'string' && row.titleCn ? row.titleCn : undefined,
      cover: typeof row.cover === 'string' && row.cover ? row.cover : undefined,
      airDate: typeof row.airDate === 'string' ? row.airDate : undefined,
      bgmTags: Array.isArray(row.bgmTags) ? row.bgmTags : [],
      userTags: Array.isArray(row.userTags) ? row.userTags : [],
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      updatedAt: Number.isFinite(updatedAtMs) && updatedAtMs > 0
        ? new Date(updatedAtMs).toISOString()
        : undefined,
    }
  })
  return normalizeTracks(projected)
}
