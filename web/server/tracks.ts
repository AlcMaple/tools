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

const STATUSES = ['watching', 'plan', 'done'] as const
type Status = (typeof STATUSES)[number]

const USER_TAG_MAX_LEN = 20
const USER_TAG_MAX_COUNT = 12

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
  updated_at: number
  cover_mime: string
}

// 本地上传封面：文件按 `<uid>_<bgmId>` 落 coversDir，不带扩展名 —— 实际类型看 cover_mime 那一列。
const coverFilePath = (uid: number, bgmId: number): string => join(coversDir, `${uid}_${bgmId}`)
const COVER_UPLOAD_MAX_BYTES = 4 * 1024 * 1024
const COVER_UPLOAD_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const parseList = (s: string): string[] => {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toJson(r: TrackRow): Record<string, unknown> {
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
    updatedAt: r.updated_at,
  }
}

/**
 * 同步专用视图 —— 比网页视图多一个 `extra`:桌面端独有的字段原样装在里面往返。
 * 网页端根本不认识它们,也**从不改写**,所以富数据过服务器一圈不会被瘦记录抹掉。
 */
function toSyncJson(r: TrackRow): Record<string, unknown> {
  let extra: unknown = {}
  try {
    const v = JSON.parse(r.extra || '{}')
    if (v && typeof v === 'object' && !Array.isArray(v)) extra = v
  } catch {
    /* 脏数据当空对象，别让一条坏记录卡住整次同步 */
  }
  return { ...toJson(r), extra }
}

// id 是插入顺序(自增,UPDATE 不会挪它)—— 按它排列表就是「按加入顺序」,不会因为编辑了某条
// (改进度/改状态都会 bump updated_at)就把它顶到最前面重新洗牌。
const listStmt = db.prepare('SELECT * FROM tracks WHERE user_id = ? ORDER BY id ASC')
const oneStmt = db.prepare('SELECT * FROM tracks WHERE user_id = ? AND bgm_id = ?')
const delStmt = db.prepare('DELETE FROM tracks WHERE user_id = ? AND bgm_id = ?')
const insertStmt = db.prepare(`
  INSERT INTO tracks (user_id, bgm_id, status, episode, total_episodes, title, title_cn, cover,
                      air_weekday, air_date, score, bgm_tags, user_tags, aliases, extra, updated_at)
  VALUES (@user_id, @bgm_id, @status, @episode, @total_episodes, @title, @title_cn, @cover,
          @air_weekday, @air_date, @score, @bgm_tags, @user_tags, @aliases, @extra, @updated_at)
`)

// ── 数据版本号（app 覆盖上传的冲突检测，见 db.ts 的 tracks_rev 注释）──────────────
const revStmt = db.prepare('SELECT tracks_rev AS rev FROM users WHERE id = ?')
const bumpRevStmt = db.prepare('UPDATE users SET tracks_rev = tracks_rev + 1 WHERE id = ?')

const currentRev = (uid: number): number => (revStmt.get(uid) as { rev: number } | undefined)?.rev ?? 0

/** 任何会改动该用户追番数据的写入都要调 —— 漏一处,桌面端就会拿着过期 rev 静默覆盖掉网页的改动。 */
const bumpRev = (uid: number): void => {
  bumpRevStmt.run(uid)
}

const readTracksSnapshot = db.transaction((uid: number) => ({
  rev: currentRev(uid),
  data: (listStmt.all(uid) as TrackRow[]).map(toJson),
}))

const readSyncSnapshot = db.transaction((uid: number) => ({
  rev: currentRev(uid),
  data: (listStmt.all(uid) as TrackRow[]).map(toSyncJson),
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
    for (const row of listStmt.all(uid) as TrackRow[]) {
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
  if (isRecentAir(airDate)) return null
  return epsOf(bgmId) || null
}

/**
 * 加追番后异步回填标签 / 别名 / 放送日期 / 老番总集数。三个细节各有理由:
 *   1. **抖动 800~2000ms 再发** —— 用户在周历上连点几部,不抖动就是一串请求瞬间砸过去。
 *   2. **发之前二次检查** —— 这段延迟里用户可能已经取消追番,或别的路径已经补上了。
 *   3. **一次请求同时拿标签 + 别名 + 放送日期 + 集数**,零额外开销。
 * 失败静默放过:下次相关入口还会触发,**绝不重试打死对面**。
 */
function fillDetailLater(uid: number, bgmId: number): void {
  const existing = oneStmt.get(uid, bgmId) as TrackRow | undefined
  if (!existing || parseList(existing.bgm_tags).length > 0) return

  const jitterMs = 800 + Math.random() * 1200
  setTimeout(() => {
    void (async () => {
      const recheck = oneStmt.get(uid, bgmId) as TrackRow | undefined
      if (!recheck || parseList(recheck.bgm_tags).length > 0) return
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

tracks.put('/:bgmId', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)

  const bgmId = Number(c.req.param('bgmId'))
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const now = Date.now()
  // 客户端提交的标题不能直接进入全站共享目录。只有服务端在线搜索签发过、且 bgmId
  // 与当前路径一致的候选才有资格在「确实插入新追番」时晋升为持久补充记录。
  const searchAddition = verifySearchAdditionToken(body.searchAdditionToken, bgmId, now)

  const hasStatus = 'status' in body
  const nextStatus = hasStatus && STATUSES.includes(body.status as Status)
    ? (body.status as Status)
    : undefined
  if (hasStatus && !nextStatus) return c.json({ error: 'status 不合法' }, 400)

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
  const write = db.transaction(() => {
    const prev = oneStmt.get(uid, bgmId) as TrackRow | undefined
    if (!prev) {
      const airDate = String(body.airDate ?? '')
      insertStmt.run({
        user_id: uid,
        bgm_id: bgmId,
        status: nextStatus ?? 'watching',
        episode: 0,
        total_episodes: initialTotal(bgmId, airDate),
        title: String(body.title ?? ''),
        title_cn: String(body.titleCn ?? ''),
        cover: String(body.cover ?? ''),
        air_weekday: Number(body.airWeekday) || weekdayFromDate(airDate),
        air_date: airDate,
        score: Number(body.score) || 0,
        bgm_tags: '[]',
        user_tags: '[]',
        aliases: '[]',
        extra: '{}', // 网页端建的记录没有 app 专属字段；app 上传时才会填
        updated_at: now,
      })
      if (searchAddition) saveSearchAddition(searchAddition, now)
      bumpRev(uid)
      return { row: oneStmt.get(uid, bgmId) as TrackRow, fillDetail: true }
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
    if (nextUserTags !== undefined) {
      sets.push('user_tags = ?')
      args.push(JSON.stringify(nextUserTags))
    }
    if (hasCover) {
      sets.push('cover = ?', 'cover_mime = ?')
      // 手填网图 URL 顶替掉本地上传：这条不再是 local 哨兵值，cover_mime 归零。
      args.push(nextCover, '')
    }

    if (!sets.length) return { row: prev, fillDetail: false }
    sets.push('updated_at = ?')
    args.push(now)
    db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE user_id = ? AND bgm_id = ?`)
      .run(...args, uid, bgmId)
    bumpRev(uid)
    // 换成网图 URL 后，原先本地上传的文件成了孤儿，顺手删掉（失败不影响这次写入）。
    if (hasCover && prev.cover_mime) void unlink(coverFilePath(uid, bgmId)).catch(() => {})
    return { row: oneStmt.get(uid, bgmId) as TrackRow, fillDetail: false }
  })
  const result = write.immediate()

  if (result.fillDetail) fillDetailLater(uid, bgmId)
  return c.json(toJson(result.row))
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
  if (!Number.isInteger(bgmId)) return c.json({ error: 'bgmId 不合法' }, 400)
  const remove = db.transaction(() => {
    const result = delStmt.run(uid, bgmId)
    if (result.changes > 0) bumpRev(uid)
  })
  remove.immediate()
  void unlink(coverFilePath(uid, bgmId)).catch(() => {})
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
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  if (!oneStmt.get(uid, bgmId)) return c.json({ error: '未追这部番' }, 404)

  const body = await c.req.parseBody().catch(() => null)
  const file = body?.file
  if (!(file instanceof File)) return c.json({ error: '没有收到图片' }, 400)
  if (!COVER_UPLOAD_MIME.has(file.type)) return c.json({ error: '只支持 PNG / JPEG / WebP / GIF' }, 400)
  if (file.size > COVER_UPLOAD_MAX_BYTES) return c.json({ error: '图片不能超过 4MB' }, 400)

  const bytes = new Uint8Array(await file.arrayBuffer())
  await writeFile(coverFilePath(uid, bgmId), bytes)

  const now = Date.now()
  const cover = `/api/tracks/${bgmId}/cover-file`
  db.prepare('UPDATE tracks SET cover = ?, cover_mime = ?, updated_at = ? WHERE user_id = ? AND bgm_id = ?')
    .run(cover, file.type, now, uid, bgmId)
  bumpRev(uid)
  return c.json(toJson(oneStmt.get(uid, bgmId) as TrackRow))
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

const MAX_TRACKS = 5000 // 一次上传的条数上限（正常用户几百条封顶）
const MAX_EXTRA_BYTES = 16 * 1024 // 单条 extra 上限：这是给 app 的自由容器，得防止被当网盘用

/** 拉取 —— 全量（含 extra）+ 当前 rev。app 要记住这个 rev，上传时带回来做冲突检测。 */
tracks.get('/sync', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const snapshot = readSyncSnapshot(uid)
  fillCalendarMetadataLater(uid)
  return c.json(snapshot)
})

/**
 * 上传 —— 整包覆盖。body: `{ baseRev, force?, data: [...] }`
 *
 * `baseRev` 对不上 = 服务器上有 app 没见过的改动（多半是你在网页上改的）→ **409，不写任何东西**，
 * 让用户去选「先拉取」还是「强制覆盖」。这是覆盖模型唯一的护栏，别为了省事默认 force。
 */
tracks.post('/sync', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)

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
    if (t.extra !== undefined && JSON.stringify(t.extra ?? {}).length > MAX_EXTRA_BYTES) {
      return c.json({ error: `条目 ${id} 的 extra 过大` }, 400)
    }
    incoming.set(id, t)
  }

  const now = Date.now()
  const apply = db.transaction(() => {
    // baseRev 比对必须在拿到写锁后发生。否则比对与真正覆盖之间穿插一个网页 PUT，
    // 旧整包仍会通过检查并静默抹掉刚写入的数据。
    const rev = currentRev(uid)
    if (body.force !== true && Number(body.baseRev) !== rev) {
      return {
        conflict: true as const,
        rev,
        serverCount: (listStmt.all(uid) as TrackRow[]).length,
      }
    }

    const existing = new Map((listStmt.all(uid) as TrackRow[]).map((r) => [r.bgm_id, r]))

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
      if ('status' in t && STATUSES.includes(t.status as Status)) put('status', t.status)
      if ('episode' in t) put('episode', Number(t.episode) || 0)
      if ('totalEpisodes' in t) put('total_episodes', asTotal(t.totalEpisodes) ?? null)
      if ('title' in t) put('title', String(t.title ?? ''))
      if ('titleCn' in t) put('title_cn', String(t.titleCn ?? ''))
      if ('cover' in t && String(t.cover ?? '')) put('cover', String(t.cover))
      // 0 / 缺失代表 app 不知道，不得把服务器从周历得到的正确信息抹掉。
      if (validIncomingWeekday) put('air_weekday', validIncomingWeekday)
      else if (existing.get(id)?.air_weekday === 0 && resolvedWeekday) put('air_weekday', resolvedWeekday)
      if ('airDate' in t && incomingAirDate) put('air_date', incomingAirDate)
      if ('score' in t) put('score', Number(t.score) || 0)
      if (Array.isArray(t.bgmTags)) put('bgm_tags', JSON.stringify(t.bgmTags))
      if (Array.isArray(t.userTags)) put('user_tags', JSON.stringify(t.userTags))
      if (Array.isArray(t.aliases)) put('aliases', JSON.stringify(t.aliases))
      if ('extra' in t) put('extra', JSON.stringify(t.extra ?? {}))
      put('updated_at', updatedAt)
      db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE user_id = ? AND bgm_id = ?`).run(...args, uid, id)
    }

    // 集合层面的覆盖：app 没带上来的，就是它那边删掉的
    for (const id of existing.keys()) if (!incoming.has(id)) delStmt.run(uid, id)

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
      },
      409,
    )
  }

  // 用户数据和 rev 已经原子提交；周历只在响应关键路径之外补空字段，并按用户单飞去重。
  fillCalendarMetadataLater(uid)
  return c.json({ rev: result.rev, count: result.count })
})

export default tracks
