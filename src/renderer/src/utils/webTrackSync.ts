import {
  normalizeTracks,
  type AnimeStatus,
  type AnimeTrack,
} from '../stores/animeTrackStore'
import { weekdayFromAirDate } from './airDate'

interface WebSyncTrack {
  bgmId: number
  status: 'watching' | 'plan' | 'done'
  episode: number
  totalEpisodes: number | null
  title: string
  titleCn: string
  cover: string
  airWeekday?: number
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

/**
 * app 富记录 → web 瘦列 + extra。
 *
 * 公共字段单独投影，让网页可以正常筛选和编辑；网页不认识的字段全部进 extra。
 * `appStatus` 专门保住「观望」：网页把它展示成「想看」，若网页没有改状态，拉回
 * app 时仍恢复成观望；网页真改成在追/看完后则以网页的新状态为准。
 */
export function toWebSyncTracks(tracks: AnimeTrack[]): WebSyncTrack[] {
  return tracks.map((track, appOrder) => {
    const weekday = track.airWeekday || weekdayFromAirDate(track.airDate)
    return {
      bgmId: track.bgmId,
      status: webStatus(track.status),
      episode: track.episode,
      totalEpisodes: track.totalEpisodes ?? null,
      title: track.title,
      titleCn: track.titleCn ?? '',
      cover: track.cover ?? '',
      // 有周历列就用精确值；老记录只有首播日期时再用日期星期兜底。未知时省略，
      // 让服务器保留 / 回填已有值，不能拿 0 把网页已经知道的星期覆盖掉。
      ...(weekday ? { airWeekday: weekday } : {}),
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
        // 服务端列表按 updated_at 排序，不能把那个顺序当成本地添加顺序。显式
        // 带上 Map 插入位置，拉回时才能还原用户原来的列表。
        appOrder,
      },
    }
  })
}

/**
 * web 同步记录 → app AnimeTrack。
 *
 * 先把 extra 展开，再用公共字段覆盖，确保网页对进度、标签、标题等字段的修改
 * 能回到 app；最后统一走 store 的 normalize，老记录和缺字段记录都安全补默认。
 */
export function fromWebSyncTracks(input: unknown): AnimeTrack[] {
  if (!Array.isArray(input)) return []
  const projected = input.map((value, remoteIndex) => {
    if (!value || typeof value !== 'object') return { value, appOrder: null, remoteIndex, createdAt: 0 }
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
    const startedAtMs = typeof extra.startedAt === 'string' ? Date.parse(extra.startedAt) : NaN
    const appOrder = Number(extra.appOrder)
    return {
      appOrder: Number.isInteger(appOrder) && appOrder >= 0 ? appOrder : null,
      remoteIndex,
      // 旧同步数据还没有 appOrder，但 app 的 startedAt 一直存在，可据此恢复
      // 原始添加顺序；纯网页创建的记录再用 updatedAt 当创建时刻兜底。
      createdAt: Number.isFinite(startedAtMs)
        ? startedAtMs
        : Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
      value: {
        ...extra,
        bgmId: Number(row.bgmId),
        status,
        episode: Number(row.episode) || 0,
        totalEpisodes: row.totalEpisodes == null ? undefined : Number(row.totalEpisodes),
        title: typeof row.title === 'string' ? row.title : '',
        titleCn: typeof row.titleCn === 'string' && row.titleCn ? row.titleCn : undefined,
        cover: typeof row.cover === 'string' && row.cover ? row.cover : undefined,
        airDate: typeof row.airDate === 'string' ? row.airDate : undefined,
        airWeekday: Number.isInteger(Number(row.airWeekday))
          && Number(row.airWeekday) >= 1 && Number(row.airWeekday) <= 7
          ? Number(row.airWeekday)
          : undefined,
        bgmTags: Array.isArray(row.bgmTags) ? row.bgmTags : [],
        userTags: Array.isArray(row.userTags) ? row.userTags : [],
        aliases: Array.isArray(row.aliases) ? row.aliases : [],
        updatedAt: Number.isFinite(updatedAtMs) && updatedAtMs > 0
          ? new Date(updatedAtMs).toISOString()
          : undefined,
      },
    }
  })
  projected.sort((a, b) => {
    if (a.appOrder !== null && b.appOrder !== null) return a.appOrder - b.appOrder
    if (a.appOrder !== null) return -1
    if (b.appOrder !== null) return 1
    return a.createdAt - b.createdAt || a.remoteIndex - b.remoteIndex
  })
  return normalizeTracks(projected.map((entry) => entry.value))
}
