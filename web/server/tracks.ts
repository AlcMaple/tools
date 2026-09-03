// 追番 API —— 用户数据,必须登录。
//
// **写入一律是字段级 patch,绝不整条替换**:body 里没给的字段保持原样,沉默 ≠ 置空。
// 这样桌面端推富记录过来时,网页端只写自己拥有的那几个字段,对方的好看集 / 绑定之类不会被抹掉。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecentAir } from '../shared/anime-age'
import { epsOf } from './bgm/anime-index'
import { getCalendarMetadata, type CalendarMetadata } from './bgm/calendar'
import {
  BGM_COLLECTION_PAGE_SIZE,
  BgmCollectionError,
  fetchBgmCollectionPage,
  normalizeBgmCollectionAnime,
  pacedRequest,
  type BgmCollectionAnime,
} from './bgm/collections'
import { fetchSubjectDetail } from './bgm/detail'
import {
  enrichSearchAddition,
  saveSearchAddition,
  verifySearchAdditionToken,
} from './bgm/search-additions'
import { db } from './db'
import { coversDir } from './data-dir'
import { getSession } from './auth'

const tracks = new Hono()

// `considering`（观望）跟 `plan`（想看）是两件事：前者「候补，看看再说」，后者「已决定追」。
const STATUSES = ['watching', 'plan', 'considering', 'done'] as const
type Status = (typeof STATUSES)[number]

const USER_TAG_MAX_LEN = 20
const USER_TAG_MAX_COUNT = 12
const MAX_TRACKS = 5000 // 单次同步 / 导入的条数上限（正常用户几百条封顶）

const isCustomBgmId = (bgmId: number): boolean => Number.isInteger(bgmId) && bgmId < 0

interface TrackRow {
  bgm_id: number
  status: string
  episode: number
  total_episodes: number | null
  title: string
  title_cn: string
  cover: string
  air_weekday: number
  air_date: string
  score: number
  bgm_tags: string
  user_tags: string
  aliases: string
  extra: string
  observe_count: number
  updated_at: number
  cover_mime: string
}

// 本地上传封面：文件按 `<uid>_<bgmId>` 落 coversDir，不带扩展名 —— 负数 bgmId 也可用，实际类型看 cover_mime 那一列。
const coverFilePath = (uid: number, bgmId: number): string => join(coversDir, `${uid}_${bgmId}`)
// DB 的 cover 列存这个哨兵路径时，才代表「图在 coversDir 里」（另一半凭据是 cover_mime 非空）。
// app 拉取时会原样拿到它、上传时又原样推回来 —— 同步那边要靠它把「推回自己的路径」和
// 「用网图顶替掉本地图」区分开，所以抽成函数，别再各处手写这个字符串。
const coverSentinel = (bgmId: number): string => `/api/tracks/${bgmId}/cover-file`
const COVER_UPLOAD_MAX_BYTES = 4 * 1024 * 1024
const COVER_UPLOAD_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 观望次数取值：先认正式字段，再认老同步数据留在 extra 里的那份（app 曾经只写那儿）。 */
function asObserve(value: unknown, extra: unknown): number {
  const direct = Number(value)
  if (Number.isInteger(direct) && direct >= 0) return direct
  const legacy = Number((extra as Record<string, unknown> | undefined)?.observeCount)
  return Number.isInteger(legacy) && legacy >= 0 ? legacy : 0
}
const hasLegacyObserve = (extra: unknown): boolean =>
  !!extra && typeof extra === 'object' && 'observeCount' in (extra as Record<string, unknown>)

/** 好看集集号归一：去掉 ≤0 / 非整数，去重升序。与 app 端 animeTrackStore 同一套规则。 */
function normalizeGoodEpisodes(input: unknown): number[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<number>()
  for (const v of input) {
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    const i = Math.floor(n)
    if (i <= 0) continue
    seen.add(i)
  }
  return [...seen].sort((a, b) => a - b)
}

const FAVORITE_MAX = 6

/** 最爱值归一：夹到 0-6 的整数，跟桌面端 animeTrackStore.FAVORITE_MAX 同一套规则。 */
function normalizeFavorite(input: unknown): number {
  const n = Number(input)
  if (!Number.isFinite(n)) return 0
  const i = Math.floor(n)
  if (i <= 0) return 0
  return Math.min(i, FAVORITE_MAX)
}

/** 备注只保留「集号仍在 eps 里 + 值非空」的项，取消标记的集其备注自动作废。 */
function normalizeGoodEpisodeNotes(input: unknown, eps: number[]): Record<number, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const allowed = new Set(eps)
  const out: Record<number, string> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const ep = Number(k)
    if (!Number.isInteger(ep) || !allowed.has(ep)) continue
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    if (trimmed) out[ep] = trimmed
  }
  return out
}

const parseList = (s: string): string[] => {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseExtra(s: string): Record<string, unknown> {
  try {
    const value = JSON.parse(s || '{}') as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function subjectTypeOf(extra: Record<string, unknown>): 'anime' | 'manga' | 'novel' | 'other' {
  return ['anime', 'manga', 'novel', 'other'].includes(String(extra.subjectType))
    ? extra.subjectType as 'anime' | 'manga' | 'novel' | 'other'
    : 'anime'
}

function toJson(r: TrackRow): Record<string, unknown> {
  const extra = parseExtra(r.extra)
  return {
    bgmId: r.bgm_id,
    status: r.status,
    episode: r.episode,
    // NULL → null(= 连载中)。**别在这里悄悄折成 0** —— 那会把「不知道总共几集」变成「总共 0 集」。
    totalEpisodes: r.total_episodes,
    title: r.title,
    titleCn: r.title_cn,
    cover: r.cover,
    airWeekday: r.air_weekday,
    airDate: r.air_date,
    score: r.score,
    bgmTags: parseList(r.bgm_tags),
    userTags: parseList(r.user_tags),
    aliases: parseList(r.aliases),
    observeCount: r.observe_count,
    // 网页版当前只展示动画，但全量同步必须保留漫画 / 小说。普通列表带上类别让前端过滤，
    // 不能在服务端 SELECT 时丢掉，否则桌面端下一次整包拉取会误删隐藏类别。
    subjectType: subjectTypeOf(extra),
    // 好看集本是桌面端专属字段（存在 extra 里）；网页版现在也能读写这两个 key，
    // 其余 extra 字段仍然原样透传、不认识、不改写。
    goodEpisodes: normalizeGoodEpisodes(extra.goodEpisodes),
    goodEpisodeNotes: normalizeGoodEpisodeNotes(extra.goodEpisodeNotes, normalizeGoodEpisodes(extra.goodEpisodes)),
    // 最爱值同样是桌面端专属字段（存在 extra 里），网页版现在也能读写它。
    favorite: normalizeFavorite(extra.favorite),
    updatedAt: r.updated_at,
  }
}

/**
 * 同步专用视图 —— 比网页视图多一个 `extra`:桌面端独有的字段原样装在里面往返。
 * 网页端根本不认识它们,也**从不改写**,所以富数据过服务器一圈不会被瘦记录抹掉。
 */
function toSyncJson(r: TrackRow): Record<string, unknown> {
  const extra = parseExtra(r.extra)
  // 已发布的 v0.16.0 只认识三态：观望必须继续投影成 plan + extra.appStatus，当前客户端
  // fromWebSyncTracks 也认这套 legacy wire。observeCount 同步镜像给旧客户端读取。
  const wireExtra = {
    ...extra,
    ...(r.status === 'considering' ? { appStatus: 'considering' } : {}),
    observeCount: r.observe_count,
  }
  return {
    ...toJson(r),
    status: r.status === 'considering' ? 'plan' : r.status,
    extra: wireExtra,
  }
}

// id 是插入顺序（自增，UPDATE 不会挪它）。网页列表按它倒序就是「最新加入在前」；编辑进度、
// 标签或状态只会 bump updated_at，绝不能借此把旧番顶回最前。同步快照仍保留原有插入顺序，
// 桌面端会依据 extra.appOrder 还原自己的列表次序。
const listByInsertStmt = db.prepare('SELECT * FROM tracks WHERE user_id = ? ORDER BY id ASC')
const listNewestFirstStmt = db.prepare('SELECT * FROM tracks WHERE user_id = ? ORDER BY id DESC')
const oneStmt = db.prepare('SELECT * FROM tracks WHERE user_id = ? AND bgm_id = ?')
const delStmt = db.prepare('DELETE FROM tracks WHERE user_id = ? AND bgm_id = ?')
const insertStmt = db.prepare(`
  INSERT INTO tracks (user_id, bgm_id, status, episode, total_episodes, title, title_cn, cover,
                      air_weekday, air_date, score, bgm_tags, user_tags, aliases, extra,
                      observe_count, updated_at)
  VALUES (@user_id, @bgm_id, @status, @episode, @total_episodes, @title, @title_cn, @cover,
          @air_weekday, @air_date, @score, @bgm_tags, @user_tags, @aliases, @extra,
          @observe_count, @updated_at)
`)
const importUpdateStmt = db.prepare(`
  UPDATE tracks
  SET status = @status,
      episode = @episode,
      total_episodes = @total_episodes,
      title = @title,
      title_cn = @title_cn,
      cover = @cover,
      cover_mime = @cover_mime,
      air_weekday = @air_weekday,
      air_date = @air_date,
      score = @score,
      updated_at = @updated_at
  WHERE user_id = @user_id AND bgm_id = @bgm_id
`)

// 同一份本地封面文件的写入 / 删除必须串行。否则导入提交后发起的异步 unlink 可能晚于
// 用户紧接着上传的新文件完成，最终把刚上传的字节删掉。删除真正执行前再看一次 DB：
// cover_mime 已恢复说明新的本地封面已经生效，这次旧孤儿清理就应作废。
const coverFileTails = new Map<string, Promise<void>>()

async function withCoverFileLock<T>(uid: number, bgmId: number, run: () => Promise<T>): Promise<T> {
  const key = `${uid}:${bgmId}`
  const previous = coverFileTails.get(key) ?? Promise.resolve()
  const operation = previous.then(run, run)
  const tail = operation.then(
    () => undefined,
    () => undefined,
  )
  coverFileTails.set(key, tail)
  void tail.then(() => {
    if (coverFileTails.get(key) === tail) coverFileTails.delete(key)
  })
  return operation
}

async function withCoverFileLocks<T>(uid: number, bgmIds: number[], run: () => Promise<T>): Promise<T> {
  const ids = [...new Set(bgmIds)].sort((a, b) => a - b)
  const acquire = (index: number): Promise<T> =>
    index >= ids.length
      ? run()
      : withCoverFileLock(uid, ids[index], () => acquire(index + 1))
  return acquire(0)
}

function cleanupOrphanedCover(uid: number, bgmId: number): void {
  void withCoverFileLock(uid, bgmId, async () => {
    const current = oneStmt.get(uid, bgmId) as TrackRow | undefined
    if (current?.cover_mime) return
    await unlink(coverFilePath(uid, bgmId))
  }).catch(() => {})
}

// ── 数据版本号（app 覆盖上传的冲突检测，见 db.ts 的 tracks_rev 注释）──────────────
const revStmt = db.prepare('SELECT tracks_rev AS rev FROM users WHERE id = ?')
const bumpRevStmt = db.prepare('UPDATE users SET tracks_rev = tracks_rev + 1 WHERE id = ?')

const currentRev = (uid: number): number => (revStmt.get(uid) as { rev: number } | undefined)?.rev ?? 0

/** 任何会改动该用户追番数据的写入都要调 —— 漏一处,桌面端就会拿着过期 rev 静默覆盖掉网页的改动。 */
const bumpRev = (uid: number): void => {
  bumpRevStmt.run(uid)
}

const publishedReviewModesStmt = db.prepare<[number]>(
  `SELECT bgm_id, mode FROM review_contents WHERE user_id = ? AND published = 1`,
)

const readTracksSnapshot = db.transaction((uid: number) => {
  const byBgm = new Map<number, string[]>()
  for (const row of publishedReviewModesStmt.all(uid) as { bgm_id: number; mode: string }[]) {
    const list = byBgm.get(row.bgm_id) ?? []
    if (row.mode === 'review' || row.mode === 'recommend') list.push(row.mode)
    byBgm.set(row.bgm_id, list)
  }
  return {
    rev: currentRev(uid),
    data: (listNewestFirstStmt.all(uid) as TrackRow[]).map((r) => ({
      ...toJson(r),
      publishedReviews: byBgm.get(r.bgm_id) ?? [],
    })),
  }
})

const readSyncSnapshot = db.transaction((uid: number) => ({
  rev: currentRev(uid),
  data: (listByInsertStmt.all(uid) as TrackRow[]).map(toSyncJson),
}))

function weekdayFromDate(date: unknown): number {
  if (typeof date !== 'string') return 0
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return 0
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return day === 0 ? 7 : day
}

async function calendarMetadata(): Promise<Map<number, CalendarMetadata>> {
  try {
    return await getCalendarMetadata()
  } catch {
    // 周历只是系统元数据补全;它临时不可用不能拖垮用户的追番读写。
    return new Map()
  }
}

const fillCalendarStmt = db.prepare(`
  UPDATE tracks
  SET air_weekday = CASE WHEN air_weekday = 0 THEN @air_weekday ELSE air_weekday END,
      air_date = CASE WHEN air_date = '' THEN @air_date ELSE air_date END,
      cover = CASE WHEN cover = '' THEN @cover ELSE cover END
  WHERE user_id = @user_id AND bgm_id = @bgm_id
`)

/**
 * 老记录没有每周放送日,用服务器已有的本季周历补齐,但**不动 updated_at / rev**:
 * 这是系统元数据回填、不是用户修改,否则一打开页面就会制造虚假的同步冲突。
 */
async function fillCalendarMetadata(uid: number): Promise<Map<number, CalendarMetadata>> {
  const metadata = await calendarMetadata()
  if (!metadata.size) return metadata
  const apply = db.transaction(() => {
    for (const row of listByInsertStmt.all(uid) as TrackRow[]) {
      const item = metadata.get(row.bgm_id)
      if (!item) continue
      if (row.air_weekday && row.air_date && row.cover) continue
      fillCalendarStmt.run({
        user_id: uid,
        bgm_id: row.bgm_id,
        air_weekday: item.weekday,
        air_date: item.airDate,
        cover: item.cover,
      })
    }
  })
  apply.immediate()
  return metadata
}

const calendarFillInFlight = new Set<number>()

function fillCalendarMetadataLater(uid: number): void {
  if (calendarFillInFlight.has(uid)) return
  calendarFillInFlight.add(uid)
  void fillCalendarMetadata(uid)
    .catch(() => {
      /* 系统元数据后台回填失败不影响已经返回的用户状态，也不制造未处理 rejection。 */
    })
    .finally(() => {
      calendarFillInFlight.delete(uid)
    })
}

async function requireUid(c: Context): Promise<number | null> {
  const s = await getSession(c)
  return s ? s.uid : null
}

/**
 * 加番那一刻定总集数。
 *
 * 规则（判据只看 airDate，与 total 本身解耦，见 shared/anime-age.ts）：
 *   - 新番 → 一律 null。**哪怕这里查得到集数也不填** —— 在播番的集数 BGM 自己常常还没定，
 *     填一个会让「进度 / 总数」显示成假的确定值；`null` = 连载中、用户想填自己填。
 *   - 老番 → 查本地离线索引。命中就直接落库，用户加完番立刻看到集数，不用等后台那一轮回填。
 *   - 老番但离线索引给不出（还没重建 / 档里没这条的章节数据）→ 先 null，交给 fillDetailLater
 *     用在线详情补。
 *
 * 查的是本机 SQLite 单行主键命中，微秒级，不会拖慢「追番」按钮。
 */
function initialTotal(bgmId: number, airDate: string): number | null {
  if (isCustomBgmId(bgmId)) return null
  if (isRecentAir(airDate)) return null
  return epsOf(bgmId) || null
}

// 这次详情请求能补的四样东西，只要还缺一样就值得发。
// **别只看 bgm_tags**：在线搜 Bangumi 加进来的条目自带标签、却没有日期和评分，
// 用「有标签 = 都齐了」当闸门会让这类卡永久停在缺日期缺评分的状态（分享图上就是
// 「放送」和「评分」两张卡整块不画）。
function needsDetail(row: TrackRow): boolean {
  return (
    parseList(row.bgm_tags).length === 0 ||
    parseList(row.aliases).length === 0 ||
    !row.air_date ||
    !(row.score > 0)
  )
}

/**
 * 加追番后异步回填标签 / 别名 / 放送日期 / 老番总集数。三个细节各有理由:
 *   1. **抖动 800~2000ms 再发** —— 用户在周历上连点几部,不抖动就是一串请求瞬间砸过去。
 *   2. **发之前二次检查** —— 这段延迟里用户可能已经取消追番,或别的路径已经补上了。
 *   3. **一次请求同时拿标签 + 别名 + 放送日期 + 集数**,零额外开销。
 * 失败静默放过:下次相关入口还会触发,**绝不重试打死对面**。
 */
function fillDetailLater(uid: number, bgmId: number): void {
  if (isCustomBgmId(bgmId)) return
  const existing = oneStmt.get(uid, bgmId) as TrackRow | undefined
  if (!existing || !needsDetail(existing)) return

  const jitterMs = 800 + Math.random() * 1200
  setTimeout(() => {
    void (async () => {
      const recheck = oneStmt.get(uid, bgmId) as TrackRow | undefined
      if (!recheck || !needsDetail(recheck)) return
      try {
        const d = await fetchSubjectDetail(bgmId)
        const apply = db.transaction(() => {
          // 网络返回后必须重新读。等待期间 app 同步可能已经写入了更完整的数据，后台补全只填
          // 此刻仍为空的字段，绝不拿请求前的旧快照覆盖新值。
          const current = oneStmt.get(uid, bgmId) as TrackRow | undefined
          if (!current) return

          const sets: string[] = []
          const args: unknown[] = []
          if (d.tags.length && parseList(current.bgm_tags).length === 0) {
            sets.push('bgm_tags = ?')
            args.push(JSON.stringify(d.tags))
          }
          if (d.aliases.length && parseList(current.aliases).length === 0) {
            sets.push('aliases = ?')
            args.push(JSON.stringify(d.aliases))
          }
          if (d.date && !current.air_date) {
            sets.push('air_date = ?')
            args.push(d.date)
          }
          if (d.score > 0 && !(current.score > 0)) {
            sets.push('score = ?')
            args.push(d.score)
          }
          if (d.cover && !current.cover) {
            sets.push('cover = ?')
            args.push(d.cover)
          }
          // 老番集数兜底 —— 走到这儿说明 initialTotal 时离线索引没给出值（索引还没重建 / 档里没这条的
          // 章节数据）。**用 d.date 而不是 current.air_date 判新老**：详情刚把日期补上，此刻库里
          // 那列可能还是空的，空串会被当成新番、白白错过这次补集数的机会。
          // 仍为空才写：用户在这 800~2000ms 里手填了的话，以用户为准。
          const total = current.total_episodes
          if (d.eps > 0 && total == null && !isRecentAir(d.date || current.air_date)) {
            sets.push('total_episodes = ?')
            args.push(d.eps)
          }
          // 详情请求本来就会执行；顺手把权威别名补进已晋升的共享条目，不增加任何 BGM 请求。
          // 该 UPDATE 只命中已有补充行，本地索引加番或普通详情回填不会凭空创建共享记录。
          enrichSearchAddition(bgmId, d.aliases, d.date)
          if (!sets.length) return

          // **不动 updated_at、也不 bump rev**:这是系统回填不是用户操作。动了 rev 的话,一次纯粹的
          // 标签补全就会把桌面端顶出 409、让它误以为「网页那边有人改过」。
          db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE user_id = ? AND bgm_id = ?`)
            .run(...args, uid, bgmId)
        })
        apply.immediate()
      } catch {
        /* 静默 —— 下次再加 / 再打开时还有机会补上 */
      }
    })()
  }, jitterMs)
}

// ── 从 Bangumi 导入 ────────────────────────────────────────────────────────────

export interface BgmImportStatus {
  state: 'running' | 'done' | 'error'
  total: number
  processed: number
  added: number
  updated: number
  failed: number
  error: string | null
}

const BGM_STATUS: Record<BgmCollectionAnime['collectionType'], Status> = {
  1: 'plan',
  2: 'done',
  3: 'watching',
  4: 'considering',
  5: 'considering',
}

const importTasks = new Map<number, BgmImportStatus>()
const importTaskTargets = new Map<number, string>()
const importInFlight = new Set<number>()
const IMPORT_HOURLY_CAP = 12
const IMPORT_FAIL_STREAK_LIMIT = 3
const IMPORT_COOLDOWN_MS = 10 * 60_000
let importHourStart = 0
let importHourCount = 0
let importFailStreak = 0
let importCooldownUntil = 0

function idleImportStatus(): BgmImportStatus {
  return { state: 'done', total: 0, processed: 0, added: 0, updated: 0, failed: 0, error: null }
}

function importGate(now: number): string | null {
  if (now < importCooldownUntil) {
    return `Bangumi 导入暂时冷却中，约 ${Math.ceil((importCooldownUntil - now) / 60000)} 分钟后再试`
  }
  if (now - importHourStart >= 3600_000) {
    importHourStart = now
    importHourCount = 0
  }
  if (importHourCount >= IMPORT_HOURLY_CAP) return 'Bangumi 导入已达本小时上限，请稍后再试'
  return null
}

function importedTotal(item: BgmCollectionAnime, airDate: string, previous: number | null): number | null {
  if (isRecentAir(airDate)) return null
  return item.eps > 0 ? item.eps : previous
}

function applyBgmImport(uid: number, items: BgmCollectionAnime[]): { added: number; updated: number; orphaned: number[] } {
  const now = Date.now()
  const orphaned: number[] = []
  const apply = db.transaction(() => {
    orphaned.length = 0
    let added = 0
    let updated = 0

    for (const item of items) {
      const previous = oneStmt.get(uid, item.bgmId) as TrackRow | undefined
      const status = BGM_STATUS[item.collectionType]
      if (!previous) {
        const total = importedTotal(item, item.airDate, null)
        insertStmt.run({
          user_id: uid,
          bgm_id: item.bgmId,
          status,
          episode: item.episode > 0 && total != null ? Math.min(item.episode, total) : item.episode,
          total_episodes: total,
          title: item.title,
          title_cn: item.titleCn,
          cover: item.cover,
          air_weekday: weekdayFromDate(item.airDate),
          air_date: item.airDate,
          score: item.score,
          bgm_tags: '[]',
          user_tags: '[]',
          aliases: '[]',
          extra: '{}',
          observe_count: 0,
          updated_at: now,
        })
        added++
        continue
      }

      const airDate = item.airDate || previous.air_date
      const total = importedTotal(item, airDate, previous.total_episodes)
      const derivedWeekday = weekdayFromDate(airDate)
      const hasBgmCover = item.cover.length > 0
      importUpdateStmt.run({
        user_id: uid,
        bgm_id: item.bgmId,
        status,
        episode: item.episode > 0
          ? total != null && total > 0 ? Math.min(item.episode, total) : item.episode
          : previous.episode,
        total_episodes: total,
        title: item.title || previous.title,
        title_cn: item.titleCn || previous.title_cn,
        cover: item.cover || previous.cover,
        cover_mime: hasBgmCover ? '' : previous.cover_mime,
        air_weekday: derivedWeekday || previous.air_weekday,
        air_date: airDate,
        score: item.score > 0 ? item.score : previous.score,
        updated_at: now,
      })
      if (hasBgmCover && previous.cover_mime) orphaned.push(item.bgmId)
      updated++
    }

    // 重复导入也属于一次明确的用户写入：已有行会按 BGM 再合并，并且 rev 每批只递增一次。
    if (items.length > 0) bumpRev(uid)
    return { added, updated }
  })
  const result = apply.immediate()
  return { ...result, orphaned: [...orphaned] }
}

/**
 * 收藏列表接口本身不带标签（`normalizeBgmCollectionAnime` 刻意不取），导入完直接落库就是
 * 一批「有进度没标签」的记录——类型筛选、标签统计全部落空。逐条详情请求补回来，但绝不能
 * 在导入收尾时一次性并发砸出去：改走 `pacedRequest`，跟收藏分页共用同一条节流队列，
 * 对 BGM 来说导入前后就是同一个人在慢慢翻页 + 慢慢点详情。
 *
 * 静默失败、不重试——下次这条记录被详情请求命中（比如用户点开编辑）还有机会补上，
 * 见 `fillDetailLater` 同样的哲学。也不 bump rev：这是系统回填，不是用户操作。
 */
async function backfillImportTags(uid: number, bgmIds: number[]): Promise<void> {
  for (const bgmId of bgmIds) {
    const current = oneStmt.get(uid, bgmId) as TrackRow | undefined
    if (!current || parseList(current.bgm_tags).length > 0) continue
    try {
      const detail = await pacedRequest(() => fetchSubjectDetail(bgmId))
      if (!detail.tags.length) continue
      const recheck = oneStmt.get(uid, bgmId) as TrackRow | undefined
      if (!recheck || parseList(recheck.bgm_tags).length > 0) continue
      db.prepare('UPDATE tracks SET bgm_tags = ? WHERE user_id = ? AND bgm_id = ?')
        .run(JSON.stringify(detail.tags), uid, bgmId)
    } catch {
      /* 静默过——缺标签不影响导入本身 */
    }
  }
}

function noteImportFailure(error: unknown, now: number): void {
  if (!(error instanceof BgmCollectionError)) return
  if (!['rate_limited', 'network', 'upstream', 'invalid_response'].includes(error.kind)) return
  importFailStreak++
  if (importFailStreak >= IMPORT_FAIL_STREAK_LIMIT) {
    importCooldownUntil = now + IMPORT_COOLDOWN_MS
    importFailStreak = 0
  }
}

async function runBgmImport(uid: number, bgmUserId: string, task: BgmImportStatus): Promise<void> {
  const items: BgmCollectionAnime[] = []
  const seen = new Set<number>()
  let offset = 0
  let requestCount = 0
  try {
    while (task.total === 0 || task.processed < task.total) {
      requestCount++
      console.info(`[bgm-import] uid=${uid} page=${requestCount} offset=${offset}`)
      const page = await fetchBgmCollectionPage(bgmUserId, offset)
      if (offset === 0) {
        if (page.total > MAX_TRACKS) throw new Error(`Bangumi 收藏超过 ${MAX_TRACKS} 部，无法一次导入`)
        task.total = page.total
        if (page.total === 0) break
      } else if (page.total !== task.total) {
        throw new BgmCollectionError('Bangumi 收藏在导入期间发生了变化，请重新导入', 'invalid_response')
      }

      const expected = Math.min(BGM_COLLECTION_PAGE_SIZE, task.total - offset)
      if (page.data.length < expected) {
        throw new BgmCollectionError('Bangumi 返回的收藏数据不完整，请稍后再试', 'invalid_response')
      }
      for (const raw of page.data.slice(0, expected)) {
        task.processed++
        const item = normalizeBgmCollectionAnime(raw)
        if (!item || seen.has(item.bgmId)) {
          task.failed++
          continue
        }
        seen.add(item.bgmId)
        items.push(item)
      }
      offset += BGM_COLLECTION_PAGE_SIZE
    }

    const result = applyBgmImport(uid, items)
    task.added = result.added
    task.updated = result.updated
    task.state = 'done'
    task.error = null
    importFailStreak = 0
    for (const bgmId of result.orphaned) cleanupOrphanedCover(uid, bgmId)
    console.info(
      `[bgm-import] uid=${uid} done total=${task.total} added=${task.added} updated=${task.updated} failed=${task.failed} requests=${requestCount}`,
    )
    // 不 await：任务已标记 done，finally 马上释放导入锁；标签回填留在后台慢慢跑，
    // 不拖导入本身的完成时间，用户可以立刻发起下一次导入。
    void backfillImportTags(uid, items.map((item) => item.bgmId))
  } catch (error) {
    task.state = 'error'
    task.error = error instanceof Error ? error.message : 'Bangumi 导入失败'
    noteImportFailure(error, Date.now())
    console.warn(`[bgm-import] uid=${uid} failed requests=${requestCount}: ${task.error}`)
  } finally {
    importInFlight.delete(uid)
  }
}

function startBgmImport(
  uid: number,
  bgmUserId: string,
  now = Date.now(),
): { status?: BgmImportStatus; error?: string; statusCode?: 409 | 429 } {
  if (importInFlight.has(uid)) {
    const current = importTasks.get(uid)
    if (importTaskTargets.get(uid) === bgmUserId && current?.state === 'running') return { status: current }
    return { error: '已有另一个 Bangumi 导入任务正在进行', statusCode: 409 }
  }
  const gateError = importGate(now)
  if (gateError) return { error: gateError, statusCode: 429 }

  const status: BgmImportStatus = {
    state: 'running',
    total: 0,
    processed: 0,
    added: 0,
    updated: 0,
    failed: 0,
    error: null,
  }
  importHourCount++
  importTasks.set(uid, status)
  importTaskTargets.set(uid, bgmUserId)
  importInFlight.add(uid)
  void runBgmImport(uid, bgmUserId, status)
  return { status }
}

tracks.get('/', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const snapshot = readTracksSnapshot(uid)
  fillCalendarMetadataLater(uid)
  return c.json(snapshot)
})

tracks.get('/revision', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  return c.json({ rev: currentRev(uid) })
})

tracks.post('/import/bgm', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const bgmUserId = typeof body.bgmUserId === 'string' ? body.bgmUserId.trim() : ''
  if (!bgmUserId) return c.json({ error: '请输入 Bangumi UID 或用户名' }, 400)
  if (bgmUserId.length > 100 || /[\u0000-\u001f\u007f]/.test(bgmUserId)) {
    return c.json({ error: 'Bangumi UID 或用户名不合法' }, 400)
  }

  const started = startBgmImport(uid, bgmUserId)
  if (started.error) return c.json({ error: started.error }, started.statusCode ?? 429)
  return c.json(started.status!, 202)
})

tracks.get('/import/bgm/status', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  return c.json(importTasks.get(uid) ?? idleImportStatus())
})

tracks.put('/:bgmId', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)

  const bgmId = Number(c.req.param('bgmId'))
  if (!Number.isInteger(bgmId) || bgmId === 0) return c.json({ error: 'bgmId 不合法' }, 400)

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const customCreation = isCustomBgmId(bgmId) && !oneStmt.get(uid, bgmId)
  const customTitle = typeof body.title === 'string' ? body.title.trim() : ''
  if (customCreation || (isCustomBgmId(bgmId) && 'title' in body)) {
    if (!customTitle) return c.json({ error: '自定义番名不能为空' }, 400)
    if (customTitle.length > 200) return c.json({ error: '自定义番名过长' }, 400)
  }
  const now = Date.now()
  // 客户端提交的标题不能直接进入全站共享目录。只有服务端在线搜索签发过、且 bgmId
  // 与当前路径一致的候选才有资格在「确实插入新追番」时晋升为持久补充记录。
  const searchAddition = verifySearchAdditionToken(body.searchAdditionToken, bgmId, now)

  const hasStatus = 'status' in body
  const nextStatus = hasStatus && STATUSES.includes(body.status as Status)
    ? (body.status as Status)
    : undefined
  if (hasStatus && !nextStatus) return c.json({ error: 'status 不合法' }, 400)

  // 观望次数：非负整数，不设上限（用户硬要一直观望不拦；跟评分类字段有意区分）
  const hasObserve = 'observeCount' in body
  const nextObserve = Number(body.observeCount)
  if (hasObserve && (!Number.isInteger(nextObserve) || nextObserve < 0)) {
    return c.json({ error: 'observeCount 不合法' }, 400)
  }

  const hasEpisode = 'episode' in body
  const nextEpisode = Number(body.episode)
  if (hasEpisode && (!Number.isInteger(nextEpisode) || nextEpisode < 0)) {
    return c.json({ error: 'episode 不合法' }, 400)
  }

  const hasTotal = 'totalEpisodes' in body
  const nextTotal = hasTotal ? asTotal(body.totalEpisodes) : null
  if (hasTotal && nextTotal === undefined) return c.json({ error: 'totalEpisodes 不合法' }, 400)

  // 网图 URL 编辑封面。本地文件上传走单独的 POST /:bgmId/cover（multipart），不经这里 ——
  // 这条 PUT 是纯 JSON body，塞不下二进制。
  const hasCover = 'cover' in body
  const nextCover = hasCover ? String(body.cover ?? '').trim() : ''
  if (hasCover && nextCover.length > 2000) return c.json({ error: '封面地址过长' }, 400)

  // 好看集：具体集号数组 + 集号→备注。两个字段都收在 extra 里，跟 app 端共用同一份存储，
  // 但更新时只动这两个 key，extra 里 app 写的其它字段原样保留（沉默 ≠ 置空）。
  const hasGoodEpisodes = 'goodEpisodes' in body
  if (hasGoodEpisodes && !Array.isArray(body.goodEpisodes)) return c.json({ error: 'goodEpisodes 不合法' }, 400)
  const hasGoodEpisodeNotes = 'goodEpisodeNotes' in body
  if (hasGoodEpisodeNotes && (!body.goodEpisodeNotes || typeof body.goodEpisodeNotes !== 'object' || Array.isArray(body.goodEpisodeNotes))) {
    return c.json({ error: 'goodEpisodeNotes 不合法' }, 400)
  }

  // 最爱值：同样收在 extra 里，跟好看集一套逻辑。
  const hasFavorite = 'favorite' in body
  if (hasFavorite && !Number.isFinite(Number(body.favorite))) return c.json({ error: 'favorite 不合法' }, 400)

  let nextUserTags: string[] | undefined
  if ('userTags' in body) {
    const list = Array.isArray(body.userTags) ? body.userTags : null
    if (!list) return c.json({ error: 'userTags 不合法' }, 400)
    nextUserTags = [...new Set(
      list
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter(Boolean),
    )]
    if (nextUserTags.length > USER_TAG_MAX_COUNT) {
      return c.json({ error: `自定义标签最多 ${USER_TAG_MAX_COUNT} 个` }, 400)
    }
    if (nextUserTags.some((t) => [...t].length > USER_TAG_MAX_LEN)) {
      return c.json({ error: `单个标签最长 ${USER_TAG_MAX_LEN} 字` }, 400)
    }
  }

  // BGM 详情不再阻塞用户写入。事务拿到写锁后重新判断记录是否存在，因此即使两个设备
  // 同时新增同一条，也不会使用 await 前的旧判断撞 UNIQUE；数据写入和 rev 永远一起提交。
  const write = db.transaction((): { row: TrackRow; fillDetail: boolean; orphanedCover: boolean; error?: string } => {
    const prev = oneStmt.get(uid, bgmId) as TrackRow | undefined
    if (!prev) {
      const airDate = String(body.airDate ?? '')
      const insertedTotal = isCustomBgmId(bgmId)
        ? (hasTotal ? nextTotal : null)
        : initialTotal(bgmId, airDate)
      const insertedEpisode = isCustomBgmId(bgmId) && hasEpisode
        ? (insertedTotal != null ? Math.min(nextEpisode, insertedTotal) : nextEpisode)
        : 0
      insertStmt.run({
        user_id: uid,
        bgm_id: bgmId,
        status: nextStatus ?? 'watching',
        episode: insertedEpisode,
        total_episodes: insertedTotal,
        title: isCustomBgmId(bgmId) ? customTitle : String(body.title ?? ''),
        title_cn: String(body.titleCn ?? ''),
        cover: String(body.cover ?? ''),
        air_weekday: Number(body.airWeekday) || weekdayFromDate(airDate),
        air_date: airDate,
        score: Number(body.score) || 0,
        bgm_tags: '[]',
        user_tags: JSON.stringify(nextUserTags ?? []),
        aliases: '[]',
        extra: (hasGoodEpisodes || hasGoodEpisodeNotes || hasFavorite)
          ? JSON.stringify({
              goodEpisodes: normalizeGoodEpisodes(body.goodEpisodes),
              goodEpisodeNotes: normalizeGoodEpisodeNotes(body.goodEpisodeNotes, normalizeGoodEpisodes(body.goodEpisodes)),
              ...(hasFavorite ? { favorite: normalizeFavorite(body.favorite) } : {}),
            })
          : '{}', // 网页端建的记录默认没有 app 专属字段；app 上传时才会填
        observe_count: hasObserve ? nextObserve : 0,
        updated_at: now,
      })
      if (searchAddition) saveSearchAddition(searchAddition, now)
      bumpRev(uid)
      return { row: oneStmt.get(uid, bgmId) as TrackRow, fillDetail: true, orphanedCover: false }
    }

    // 更新只写 body 里明确给了的字段；没给的一个都不碰。
    const sets: string[] = []
    const args: unknown[] = []
    if (hasStatus) {
      sets.push('status = ?')
      args.push(nextStatus)
    }
    if (hasEpisode) {
      // 夹到总集数上限 —— 跟 app 的 normalize 一致（用户可能把总集数改小到已看集数以下）
      const total = hasTotal ? nextTotal : prev.total_episodes
      sets.push('episode = ?')
      args.push(total != null && total > 0 ? Math.min(nextEpisode, total) : nextEpisode)
    }
    if (hasTotal) {
      sets.push('total_episodes = ?')
      args.push(nextTotal)
      // 总集数改小了 → 已看集数跟着夹住（body 里没同时给 episode 时也要处理）
      if (nextTotal != null && !hasEpisode && prev.episode > nextTotal) {
        sets.push('episode = ?')
        args.push(nextTotal)
      }
    }
    if (hasObserve) {
      sets.push('observe_count = ?')
      args.push(nextObserve)
    }
    if (nextUserTags !== undefined) {
      sets.push('user_tags = ?')
      args.push(JSON.stringify(nextUserTags))
    }
    if (hasCover) {
      sets.push('cover = ?', 'cover_mime = ?')
      // 手填网图 URL 顶替掉本地上传：这条不再是 local 哨兵值，cover_mime 归零。
      args.push(nextCover, '')
    }
    if (hasGoodEpisodes || hasGoodEpisodeNotes || hasFavorite) {
      const prevExtra = parseExtra(prev.extra)
      const nextEpisodes = hasGoodEpisodes ? normalizeGoodEpisodes(body.goodEpisodes) : normalizeGoodEpisodes(prevExtra.goodEpisodes)
      const nextNotes = normalizeGoodEpisodeNotes(
        hasGoodEpisodeNotes ? body.goodEpisodeNotes : prevExtra.goodEpisodeNotes,
        nextEpisodes,
      )
      const nextFavorite = hasFavorite ? normalizeFavorite(body.favorite) : normalizeFavorite(prevExtra.favorite)
      const nextExtraStr = JSON.stringify({ ...prevExtra, goodEpisodes: nextEpisodes, goodEpisodeNotes: nextNotes, favorite: nextFavorite })
      if (nextExtraStr.length > MAX_EXTRA_BYTES) {
        return { row: prev, fillDetail: false, orphanedCover: false, error: '好看集数据过大' }
      }
      sets.push('extra = ?')
      args.push(nextExtraStr)
    }

    if (!sets.length) return { row: prev, fillDetail: false, orphanedCover: false }
    sets.push('updated_at = ?')
    args.push(now)
    db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE user_id = ? AND bgm_id = ?`)
      .run(...args, uid, bgmId)
    bumpRev(uid)
    return {
      row: oneStmt.get(uid, bgmId) as TrackRow,
      fillDetail: false,
      orphanedCover: hasCover && !!prev.cover_mime,
    }
  })
  const result = write.immediate()
  if (result.error) return c.json({ error: result.error }, 400)

  if (result.orphanedCover) cleanupOrphanedCover(uid, bgmId)
  if (result.fillDetail) fillDetailLater(uid, bgmId)
  return c.json(toJson(result.row))
})

// 手动条目回填：只替换 bgmId 与 BGM 元数据，用户状态、进度、自定义标签和封面归属原卡保留。
// 本地封面按 uid+bgmId 命名，迁移时在同一把文件锁下复制到新 ID，再提交 DB 主键变更。
tracks.post('/:customBgmId/backfill', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)

  const customBgmId = Number(c.req.param('customBgmId'))
  if (!isCustomBgmId(customBgmId)) return c.json({ error: '这不是自定义条目' }, 400)

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const bgmId = Number(body.bgmId)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'BGM ID 不合法' }, 400)
  if (!oneStmt.get(uid, customBgmId)) return c.json({ error: '自定义条目已经不在手帐里了' }, 404)
  if (oneStmt.get(uid, bgmId)) return c.json({ error: '这部 BGM 已经在手帐里了，请先处理重复条目' }, 409)

  let detail: Awaited<ReturnType<typeof fetchSubjectDetail>>
  try {
    detail = await fetchSubjectDetail(bgmId, 8000)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'BGM 详情读取失败'
    return c.json({ error: `BGM 详情没接上：${message}` }, 502)
  }

  const now = Date.now()
  const oldCoverPath = coverFilePath(uid, customBgmId)
  const newCoverPath = coverFilePath(uid, bgmId)
  try {
    const result = await withCoverFileLocks(uid, [customBgmId, bgmId], async () => {
      const source = oneStmt.get(uid, customBgmId) as TrackRow | undefined
      if (!source) return { kind: 'missing' as const }
      if (oneStmt.get(uid, bgmId)) return { kind: 'duplicate' as const }

      const sourceHasCoverSentinel = source.cover === coverSentinel(customBgmId)
      const sourceHasLocalCover = sourceHasCoverSentinel && !!source.cover_mime
      let localBytes: Buffer | null = null
      if (sourceHasLocalCover) {
        try {
          const bytes = await readFile(oldCoverPath)
          await writeFile(newCoverPath, bytes)
          localBytes = bytes
        } catch {
          localBytes = null
          await unlink(newCoverPath).catch(() => {})
        }
      }

      const apply = db.transaction(() => {
        const current = oneStmt.get(uid, customBgmId) as TrackRow | undefined
        if (!current) return { kind: 'missing' as const }
        if (oneStmt.get(uid, bgmId)) return { kind: 'duplicate' as const }

        const keepLocalCover = localBytes !== null
          && current.cover === coverSentinel(customBgmId)
          && !!current.cover_mime
        const hasUserCover = !!current.cover && (current.cover !== coverSentinel(customBgmId) || keepLocalCover)
        const title = detail.name.trim() || current.title
        const titleCn = detail.nameCn.trim()
        const airDate = detail.date || current.air_date
        const airWeekday = detail.date ? weekdayFromDate(detail.date) || current.air_weekday : current.air_weekday
        const totalEpisodes = detail.eps > 0 ? Math.max(detail.eps, current.episode) : current.total_episodes
        const nextCover = keepLocalCover
          ? coverSentinel(bgmId)
          : hasUserCover
            ? current.cover
            : detail.cover
        const nextMime = keepLocalCover ? current.cover_mime : ''

        db.prepare(`
          UPDATE tracks
          SET bgm_id = ?,
              title = ?, title_cn = ?,
              cover = ?, cover_mime = ?,
              air_weekday = ?, air_date = ?, score = ?,
              bgm_tags = ?, aliases = ?, total_episodes = ?, updated_at = ?
          WHERE user_id = ? AND bgm_id = ?
        `).run(
          bgmId,
          title,
          titleCn,
          nextCover,
          nextMime,
          airWeekday,
          airDate,
          detail.score > 0 ? detail.score : current.score,
          detail.tags.length ? JSON.stringify(detail.tags) : current.bgm_tags,
          detail.aliases.length ? JSON.stringify(detail.aliases) : current.aliases,
          totalEpisodes,
          now,
          uid,
          customBgmId,
        )
        saveSearchAddition({
          bgmId,
          name: detail.name.trim() || title,
          nameCn: detail.nameCn.trim() || titleCn,
          date: detail.date,
          score: detail.score,
        }, now)
        bumpRev(uid)
        return {
          kind: 'ok' as const,
          keepLocalCover,
          row: oneStmt.get(uid, bgmId) as TrackRow,
        }
      })
      let applied: ReturnType<typeof apply>
      try {
        applied = apply.immediate()
      } catch (error) {
        if (localBytes !== null) await unlink(newCoverPath).catch(() => {})
        throw error
      }
      if (applied.kind === 'ok') {
        if (localBytes !== null && !applied.keepLocalCover) await unlink(newCoverPath).catch(() => {})
        if (sourceHasCoverSentinel) await unlink(oldCoverPath).catch(() => {})
      } else if (localBytes !== null) {
        await unlink(newCoverPath).catch(() => {})
      }
      return applied
    })

    if (result.kind === 'missing') return c.json({ error: '自定义条目已经不在手帐里了' }, 404)
    if (result.kind === 'duplicate') return c.json({ error: '这部 BGM 已经在手帐里了，请先处理重复条目' }, 409)
    return c.json(toJson(result.row))
  } catch (error) {
    const message = error instanceof Error ? error.message : '自定义条目回填失败'
    return c.json({ error: `回填没有完成：${message}` }, 500)
  }
})

/** null / '' → null（连载中）；正整数 → 它自己；其余 → undefined（= 不合法） */
function asTotal(v: unknown): number | null | undefined {
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

tracks.delete('/:bgmId', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const bgmId = Number(c.req.param('bgmId'))
  if (!Number.isInteger(bgmId) || bgmId === 0) return c.json({ error: 'bgmId 不合法' }, 400)
  const remove = db.transaction(() => {
    const result = delStmt.run(uid, bgmId)
    if (result.changes > 0) bumpRev(uid)
  })
  remove.immediate()
  cleanupOrphanedCover(uid, bgmId)
  return c.json({ ok: true })
})

/**
 * 本地图片上传封面。multipart，字段名 `file`。图片直接落 coversDir，DB 只存一个
 * `/api/tracks/<bgmId>/cover-file` 哨兵路径 + cover_mime，真正字节从不进 SQLite。
 */
tracks.post('/:bgmId/cover', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const bgmId = Number(c.req.param('bgmId'))
  if (!Number.isInteger(bgmId) || bgmId === 0) return c.json({ error: 'bgmId 不合法' }, 400)
  if (!oneStmt.get(uid, bgmId)) return c.json({ error: '未追这部番' }, 404)

  const body = await c.req.parseBody().catch(() => null)
  const file = body?.file
  if (!(file instanceof File)) return c.json({ error: '没有收到图片' }, 400)
  if (!COVER_UPLOAD_MIME.has(file.type)) return c.json({ error: '只支持 PNG / JPEG / WebP / GIF' }, 400)
  if (file.size > COVER_UPLOAD_MAX_BYTES) return c.json({ error: '图片不能超过 4MB' }, 400)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const updated = await withCoverFileLock(uid, bgmId, async () => {
    await writeFile(coverFilePath(uid, bgmId), bytes)
    const apply = db.transaction(() => {
      if (!oneStmt.get(uid, bgmId)) return undefined
      db.prepare('UPDATE tracks SET cover = ?, cover_mime = ?, updated_at = ? WHERE user_id = ? AND bgm_id = ?')
        .run(coverSentinel(bgmId), file.type, Date.now(), uid, bgmId)
      bumpRev(uid)
      return oneStmt.get(uid, bgmId) as TrackRow
    })
    const row = apply.immediate()
    if (!row) await unlink(coverFilePath(uid, bgmId)).catch(() => {})
    return row
  })
  if (!updated) return c.json({ error: '未追这部番' }, 404)
  return c.json(toJson(updated))
})

/**
 * 只读端点，给在线播放页（xifan.ts / girigiri.ts 的裸 HTML 播放器）用：不追这部番 /
 * 没标过都返回空，不当错误——播放页只是想知道「这集是不是我标过的好看集」，不是追番详情页。
 */
tracks.get('/:bgmId/good-episodes', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const bgmId = Number(c.req.param('bgmId'))
  if (!Number.isInteger(bgmId) || bgmId === 0) return c.json({ error: 'bgmId 不合法' }, 400)
  c.header('Cache-Control', 'no-store')
  const row = oneStmt.get(uid, bgmId) as TrackRow | undefined
  if (!row) return c.json({ goodEpisodes: [], goodEpisodeNotes: {} })
  const extra = parseExtra(row.extra)
  const goodEpisodes = normalizeGoodEpisodes(extra.goodEpisodes)
  return c.json({ goodEpisodes, goodEpisodeNotes: normalizeGoodEpisodeNotes(extra.goodEpisodeNotes, goodEpisodes) })
})

/** 本地上传封面的读取端。要登录、且只能读自己那份 —— uid 从会话拿，不信路径。 */
tracks.get('/:bgmId/cover-file', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const bgmId = Number(c.req.param('bgmId'))
  if (!Number.isInteger(bgmId)) return c.json({ error: 'bgmId 不合法' }, 400)
  const row = oneStmt.get(uid, bgmId) as TrackRow | undefined
  if (!row || !row.cover_mime) return c.json({ error: '没有本地封面' }, 404)
  try {
    const bytes = await readFile(coverFilePath(uid, bgmId))
    c.header('Content-Type', row.cover_mime)
    c.header('Cache-Control', 'private, max-age=3600')
    return c.body(bytes)
  } catch {
    return c.json({ error: '封面文件丢失' }, 404)
  }
})

// ── app 同步──────────────────────────────────
//
// 形态是**用户声明方向的整包覆盖**，不是自动 merge：网页实时直连服务器，app 手动「拉取 / 上传」。
// 所以这里**没有删除墓碑** —— 覆盖模型下删除天然生效（整份替换），墓碑是 merge 模型才需要的。
//
// 但「整包」只管**集合**（谁存在），字段仍走**字段级 patch**：app 不认识 airWeekday / score，
// 上传时不会带这两个字段，若整条替换就会把网页记录的放送星期抹成 0、周历分组就散了。
// 所以已存在的记录只写 app 明确给了的字段。

const MAX_EXTRA_BYTES = 16 * 1024 // 单条 extra 上限：这是给 app 的自由容器，得防止被当网盘用
const SYNC_SCHEMA = 2

function syncExtra(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function syncStatus(status: unknown, extra: Record<string, unknown>): Status | null {
  if (status === 'plan' && extra.appStatus === 'considering') return 'considering'
  return STATUSES.includes(status as Status) ? status as Status : null
}

function statusCounts(uid: number): Record<Status, number> {
  const counts: Record<Status, number> = { watching: 0, plan: 0, considering: 0, done: 0 }
  for (const row of listByInsertStmt.all(uid) as TrackRow[]) {
    if (STATUSES.includes(row.status as Status)) counts[row.status as Status]++
  }
  return counts
}

/** 拉取 —— 全量（含 extra）+ 当前 rev。app 要记住这个 rev，上传时带回来做冲突检测。 */
tracks.get('/sync', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const snapshot = readSyncSnapshot(session.uid)
  fillCalendarMetadataLater(session.uid)
  return c.json({
    ...snapshot,
    syncSchema: SYNC_SCHEMA,
    accountId: session.uid,
    username: session.username,
    statusCounts: statusCounts(session.uid),
  })
})

/**
 * 上传 —— 整包覆盖。body: `{ baseRev, force?, data: [...] }`
 *
 * `baseRev` 对不上 = 服务器上有 app 没见过的改动（多半是你在网页上改的）→ **409，不写任何东西**，
 * 让用户去选「先拉取」还是「强制覆盖」。这是覆盖模型唯一的护栏，别为了省事默认 force。
 */
tracks.post('/sync', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const uid = session.uid

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const list = body.data
  if (!Array.isArray(list)) return c.json({ error: 'data 必须是数组' }, 400)
  if (list.length > MAX_TRACKS) return c.json({ error: `一次最多同步 ${MAX_TRACKS} 条` }, 400)

  // 先全部校验、再落库：一条不合法就整批拒绝，不留半套数据
  const incoming = new Map<number, Record<string, unknown>>()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') return c.json({ error: '记录格式不对' }, 400)
    const t = raw as Record<string, unknown>
    const id = Number(t.bgmId)
    // 负数 id 是 app 的**手动条目**（BGM 还没有的未播出续季），必须放行；0 才是非法
    if (!Number.isInteger(id) || id === 0) return c.json({ error: `bgmId 不合法：${String(t.bgmId)}` }, 400)
    if (incoming.has(id)) return c.json({ error: `bgmId 重复：${id}` }, 400)
    if (t.extra !== undefined && JSON.stringify(t.extra ?? {}).length > MAX_EXTRA_BYTES) {
      return c.json({ error: `条目 ${id} 的 extra 过大` }, 400)
    }
    const extra = syncExtra(t.extra)
    const status = syncStatus(t.status, extra)
    if (!status) return c.json({ error: `条目 ${id} 的 status 不受支持：${String(t.status)}` }, 400)
    incoming.set(id, { ...t, status, ...('extra' in t ? { extra } : {}) })
  }

  const now = Date.now()
  // 这一趟同步里失去本地封面的 bgmId（被网图顶替、或整条被删）。文件删除是异步的、且不该
  // 参与事务：事务一旦回滚，图已经删了就找不回来。所以只在这里记账，等提交成功后再落地。
  const orphaned: number[] = []
  const apply = db.transaction(() => {
    orphaned.length = 0 // 事务体可能被重入，别把上一趟的账带进来
    // baseRev 比对必须在拿到写锁后发生。否则比对与真正覆盖之间穿插一个网页 PUT，
    // 旧整包仍会通过检查并静默抹掉刚写入的数据。
    const rev = currentRev(uid)
    if (body.force !== true && Number(body.baseRev) !== rev) {
      return {
        conflict: true as const,
        rev,
        serverCount: (listByInsertStmt.all(uid) as TrackRow[]).length,
      }
    }

    const existing = new Map((listByInsertStmt.all(uid) as TrackRow[]).map((r) => [r.bgm_id, r]))

    for (const [id, t] of incoming) {
      // 客户端时钟可能不准；未来的时间会让这条永远排在列表最前，夹到 now 为止
      const ts = Number(t.updatedAt)
      const updatedAt = Number.isFinite(ts) && ts > 0 ? Math.min(ts, now) : now
      const incomingWeekday = Number(t.airWeekday)
      const validIncomingWeekday = Number.isInteger(incomingWeekday)
        && incomingWeekday >= 1 && incomingWeekday <= 7
        ? incomingWeekday
        : 0
      const incomingAirDate = String(t.airDate ?? '')
      const resolvedWeekday = validIncomingWeekday
        || weekdayFromDate(incomingAirDate)

      if (!existing.has(id)) {
        insertStmt.run({
          user_id: uid,
          bgm_id: id,
          status: STATUSES.includes(t.status as Status) ? (t.status as Status) : 'watching',
          episode: Number(t.episode) || 0,
          total_episodes: asTotal(t.totalEpisodes) ?? null,
          title: String(t.title ?? ''),
          title_cn: String(t.titleCn ?? ''),
          cover: String(t.cover ?? ''),
          air_weekday: resolvedWeekday,
          air_date: incomingAirDate,
          score: Number(t.score) || 0,
          bgm_tags: JSON.stringify(Array.isArray(t.bgmTags) ? t.bgmTags : []),
          user_tags: JSON.stringify(Array.isArray(t.userTags) ? t.userTags : []),
          aliases: JSON.stringify(Array.isArray(t.aliases) ? t.aliases : []),
          extra: JSON.stringify(t.extra ?? {}),
          observe_count: asObserve(t.observeCount, t.extra),
          updated_at: updatedAt,
        })
        continue
      }

      // 已存在 —— 只写 app 明确给了的字段（没给的保持沉默，如网页记的 airWeekday / score）
      const sets: string[] = []
      const args: unknown[] = []
      const put = (col: string, v: unknown): void => {
        sets.push(`${col} = ?`)
        args.push(v)
      }
      put('status', t.status)
      if ('episode' in t) put('episode', Number(t.episode) || 0)
      if ('totalEpisodes' in t) put('total_episodes', asTotal(t.totalEpisodes) ?? null)
      if ('title' in t) put('title', String(t.title ?? ''))
      if ('titleCn' in t) put('title_cn', String(t.titleCn ?? ''))
      // 本地上传的封面被 app 推来的网图顶替时，cover_mime 必须跟着归零、盘上的文件跟着删。
      // 只写 cover 会落到「cover 是网址、cover_mime 却说本地还有文件」的错位态：孤儿文件永久留盘，
      // 且 GET /cover-file 仍然认 cover_mime、继续把旧图吐出来。PUT 那条路径一直是这么处理的。
      // 但 app 把拉取到的哨兵路径**原样推回来**不算顶替 —— 那正是本地图自己，清了就把图删没了。
      if ('cover' in t && String(t.cover ?? '')) {
        const nextCover = String(t.cover)
        put('cover', nextCover)
        if (existing.get(id)?.cover_mime && nextCover !== coverSentinel(id)) {
          put('cover_mime', '')
          orphaned.push(id)
        }
      }
      // 0 / 缺失代表 app 不知道，不得把服务器从周历得到的正确信息抹掉。
      if (validIncomingWeekday) put('air_weekday', validIncomingWeekday)
      else if (existing.get(id)?.air_weekday === 0 && resolvedWeekday) put('air_weekday', resolvedWeekday)
      if ('airDate' in t && incomingAirDate) put('air_date', incomingAirDate)
      if ('score' in t) put('score', Number(t.score) || 0)
      if (Array.isArray(t.bgmTags)) put('bgm_tags', JSON.stringify(t.bgmTags))
      if (Array.isArray(t.userTags)) put('user_tags', JSON.stringify(t.userTags))
      if (Array.isArray(t.aliases)) put('aliases', JSON.stringify(t.aliases))
      if ('extra' in t) put('extra', JSON.stringify(t.extra ?? {}))
      if ('observeCount' in t || hasLegacyObserve(t.extra)) put('observe_count', asObserve(t.observeCount, t.extra))
      put('updated_at', updatedAt)
      db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE user_id = ? AND bgm_id = ?`).run(...args, uid, id)
    }

    // 集合层面的覆盖：app 没带上来的，就是它那边删掉的
    // 单条 DELETE /:bgmId 一直会顺手 unlink 本地封面；这条批量删除以前漏了，
    // 于是从 app 删番 = 图片文件永久留在 coversDir 里只增不减。
    for (const id of existing.keys()) {
      if (incoming.has(id)) continue
      delStmt.run(uid, id)
      if (existing.get(id)?.cover_mime) orphaned.push(id)
    }

    bumpRev(uid)
    return { conflict: false as const, rev: currentRev(uid), count: incoming.size }
  })
  const result = apply.immediate()

  if (result.conflict) {
    return c.json(
      {
        error: '服务器上有你还没拉取过的改动',
        rev: result.rev,
        conflict: true,
        serverCount: result.serverCount,
        syncSchema: SYNC_SCHEMA,
        accountId: uid,
        username: session.username,
      },
      409,
    )
  }

  // 事务已提交，这批本地封面确定没人再引用了 —— 现在删文件才是安全的（删失败不影响这次同步）。
  for (const id of orphaned) cleanupOrphanedCover(uid, id)

  // 用户数据和 rev 已经原子提交；周历只在响应关键路径之外补空字段，并按用户单飞去重。
  fillCalendarMetadataLater(uid)
  return c.json({
    rev: result.rev,
    count: result.count,
    syncSchema: SYNC_SCHEMA,
    accountId: uid,
    username: session.username,
    statusCounts: statusCounts(uid),
  })
})

export default tracks
