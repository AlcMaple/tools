import {
  normalizeTracks,
  type AnimeStatus,
  type AnimeTrack,
} from '../stores/animeTrackStore'
import { weekdayFromAirDate } from './airDate'

interface WebSyncTrack {
  bgmId: number
  status: 'watching' | 'plan' | 'considering' | 'done'
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
  observeCount: number
  updatedAt: number
  extra: Record<string, unknown>
}

const APP_STATUSES: ReadonlyArray<AnimeStatus> = ['plan', 'watching', 'completed', 'considering']

function webStatus(status: AnimeStatus): WebSyncTrack['status'] {
  return status === 'completed' ? 'done' : status
}

function appStatus(status: unknown): AnimeStatus {
  if (status === 'done') return 'completed'
  if (status === 'watching') return 'watching'
  if (status === 'considering') return 'considering'
  return 'plan'
}

/**
 * app 的富记录 → 网页版的瘦列 + extra。
 *
 * 公共字段单独投影,让网页能正常筛选和编辑;网页不认识的字段全部塞进 extra。
 * 网页端现在自己也有「观望」和观望次数,两边状态一一对应,不再需要折叠 + `extra.appStatus`
 * 兜回来那套(老数据里的 `extra.appStatus` 仍然认,见 fromWebSyncTracks)。
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
      // 有周历列就用精确值,老记录只有首播日期时用日期的星期兜底。未知时**省略字段** ——
      // 让服务器保留已有值,不能拿 0 把网页已经知道的星期覆盖掉。
      ...(weekday ? { airWeekday: weekday } : {}),
      airDate: track.airDate ?? '',
      bgmTags: track.bgmTags,
      userTags: track.userTags,
      aliases: track.aliases,
      // 观望次数是网页也要读写的正式字段。**不再往 extra 里塞一份** —— 一份数据两处存,
      // 迟早对不上(见 AI_GUIDELINES「一份数据拆成两半」)。
      observeCount: track.observeCount,
      updatedAt: new Date(track.updatedAt).getTime() || Date.now(),
      extra: {
        appStatus: track.status,
        subjectType: track.subjectType,
        bindings: track.bindings,
        notes: track.notes,
        favorite: track.favorite,
        novelVolume: track.novelVolume,
        novelChapter: track.novelChapter,
        goodEpisodes: track.goodEpisodes,
        goodEpisodeNotes: track.goodEpisodeNotes,
        startedAt: track.startedAt,
        // 服务端列表按更新时间排序,不能把那个顺序当成本地的添加顺序。显式带上插入位置
        // 拉回时才能还原用户原来的列表顺序。
        appOrder,
      },
    }
  })
}

/**
 * 网页记录 → app 记录。先展开 extra,再用公共字段覆盖,确保网页对进度、标签、标题的修改能回来;
 * 最后统一走 store 的 normalize,老记录和缺字段的记录都能安全补默认值。
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
    // 老同步数据里「观望」是被折成 `plan` 存的,真状态藏在 `extra.appStatus`。那批数据
    // 必须继续认,否则升级后所有观望记录一次性退化成想看(下次上传就会写成正式的
    // `considering` + observeCount,自动痊愈)。
    const legacyConsidering = preserved === 'considering' && row.status === 'plan'
    const status = preserved && (webStatus(preserved) === row.status || legacyConsidering)
      ? preserved
      : appStatus(row.status)
    const updatedAtMs = Number(row.updatedAt)
    const startedAtMs = typeof extra.startedAt === 'string' ? Date.parse(extra.startedAt) : NaN
    const appOrder = Number(extra.appOrder)
    const formalObserve = Number(row.observeCount)
    const legacyObserve = Number(extra.observeCount)
    const observeCount = Number.isInteger(formalObserve) && formalObserve >= 0
      ? legacyConsidering && formalObserve === 0 && Number.isInteger(legacyObserve) && legacyObserve > 0
        ? legacyObserve
        : formalObserve
      : Number.isInteger(legacyObserve) && legacyObserve >= 0 ? legacyObserve : 0
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
        observeCount,
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

/** 上传后回读只比较跨端协议拥有的语义；不含 updatedAt（服务器会夹掉未来时钟）。 */
export function webTrackSyncFingerprint(tracks: AnimeTrack[]): string {
  const projected = tracks.map((track) => ({
    bgmId: track.bgmId,
    subjectType: track.subjectType,
    status: track.status,
    episode: track.episode,
    totalEpisodes: track.totalEpisodes ?? null,
    title: track.title,
    titleCn: track.titleCn ?? '',
    cover: track.cover ?? '',
    airDate: track.airDate ?? '',
    airWeekday: track.airWeekday ?? 0,
    bgmTags: track.bgmTags,
    userTags: track.userTags,
    aliases: track.aliases,
    observeCount: track.observeCount,
    bindings: track.bindings,
    notes: track.notes,
    favorite: track.favorite,
    novelVolume: track.novelVolume,
    novelChapter: track.novelChapter,
    goodEpisodes: track.goodEpisodes,
    goodEpisodeNotes: track.goodEpisodeNotes,
    startedAt: track.startedAt,
  }))
  projected.sort((a, b) => a.bgmId - b.bgmId)
  return JSON.stringify(projected)
}
