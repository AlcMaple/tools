// 追番 API —— 用户数据，必须登录。
//
// **写入一律是「字段级 patch」，绝不整条替换**（ideas/012「同步策略」的铁律）：body 里没给的字段
// **保持沉默、原样不动**，沉默 ≠ 置空。现在还没接 app 同步，但这条从第一天就得立住 —— 将来 app
// 推富记录过来时，web 只写自己拥有的那几个字段，app 的 goodEpisodes / bindings 之类不会被抹掉。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { fetchSubjectDetail } from './bgm/detail'
import { db } from './db'
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
}

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
    // NULL → null（= 连载中）。别在这里悄悄折成 0，那会把「不知道总共几集」变成「总共 0 集」
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
 * 同步专用视图 —— 比网页视图多一个 `extra`：app 独有的字段（bindings / notes / goodEpisodes /
 * novelVolume / subjectType…）原样装在里面往返。网页端根本不认识它们，也**从不改写它，所以
 * app 的富数据过服务器一圈不会被瘦记录抹掉（012 那条铁律）。
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

const listStmt = db.prepare('SELECT * FROM tracks WHERE user_id = ? ORDER BY updated_at DESC')
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

/** 任何会改动该用户追番数据的写入都要调 —— 漏一处，app 就会拿着过期 rev 静默覆盖掉网页的改动 */
const bumpRev = (uid: number): void => {
  bumpRevStmt.run(uid)
}

async function requireUid(c: Context): Promise<number | null> {
  const s = await getSession(c)
  return s ? s.uid : null
}

/**
 * 加追番后异步回填标签 / 别名 / 放送日期 —— 服务端版的 app `ensureBgmTagsFilled`。
 *
 * 三个细节都是从 app 那边抄的，每个都有理由：
 *   1. **抖动 800-2000ms 再发** —— 用户在周历上连点几部，不抖动就是一串请求瞬间砸向 BGM。
 *   2. **发之前二次检查** —— 延迟这段时间里用户可能已经取消追番，或别的路径已经补上了。
 *   3. **一次 detail 同时拿标签 + 别名 + 放送日期**（零额外请求）。
 * 失败就静默放过：下次相关入口会再触发，绝不重试打死对面（CLAUDE.md 网络红线）。
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
        const sets: string[] = []
        const args: unknown[] = []
        if (d.tags.length) { sets.push('bgm_tags = ?'); args.push(JSON.stringify(d.tags)) }
        if (d.aliases.length) { sets.push('aliases = ?'); args.push(JSON.stringify(d.aliases)) }
        if (d.date && !recheck.air_date) { sets.push('air_date = ?'); args.push(d.date) }
        if (d.cover && !recheck.cover) { sets.push('cover = ?'); args.push(d.cover) }
        if (!sets.length) return
        // 注意**不动 updated_at、也不 bumpRev**：这是系统回填，不是用户操作。
        // 动了 rev 的话，app 会被一次纯粹的标签补全顶出 409、误以为「网页那边有人改过」
        db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE user_id = ? AND bgm_id = ?`)
          .run(...args, uid, bgmId)
      } catch {
        /* 静默 —— 下次再加 / 再打开时还有机会补上 */
      }
    })()
  }, jitterMs)
}

tracks.get('/', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  return c.json({ data: (listStmt.all(uid) as TrackRow[]).map(toJson) })
})

tracks.put('/:bgmId', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)

  const bgmId = Number(c.req.param('bgmId'))
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const now = Date.now()
  const prev = oneStmt.get(uid, bgmId) as TrackRow | undefined

  if (!prev) {
    // 新增 —— 周历点「追番」走这条。
    const status = STATUSES.includes(body.status as Status) ? (body.status as Status) : 'watching'

    // 同步取一次 BGM 详情，把标签 / 别名 / 放送日期直接带进新记录 —— 用户点完「追番」
    // 切到本页就能立刻看到标签（香港→BGM 实测 ~130ms），不必等异步回填再手动刷新。
    // BGM 抖动 / 限流**不能让追番本身失败**：取不到就先空着插入，挂 fillDetailLater
    // 后台兜底（沿用 app 容错，符合 CLAUDE.md 网络红线：失败不重试、附属数据不拖垮主
    // 操作）。短超时 4s，避免慢响应把「追番」按钮卡住。
    let bgmTags = '[]'
    let aliases = '[]'
    let airDate = String(body.airDate ?? '')
    let cover = String(body.cover ?? '') // 周历加番会带 cover；搜索加番不带 → 下面用 detail 的封面补
    try {
      const d = await fetchSubjectDetail(bgmId, 4000)
      if (d.tags.length) bgmTags = JSON.stringify(d.tags)
      if (d.aliases.length) aliases = JSON.stringify(d.aliases)
      if (d.date && !airDate) airDate = d.date
      if (d.cover && !cover) cover = d.cover
    } catch {
      /* 静默 —— 下面按需挂 fillDetailLater 兜底 */
    }

    insertStmt.run({
      user_id: uid,
      bgm_id: bgmId,
      status,
      episode: 0,
      total_episodes: null, // 连载中 —— 周历不返 eps，由用户手填
      title: String(body.title ?? ''),
      title_cn: String(body.titleCn ?? ''),
      cover,
      air_weekday: Number(body.airWeekday) || 0,
      air_date: airDate,
      score: Number(body.score) || 0,
      bgm_tags: bgmTags,
      user_tags: '[]',
      aliases,
      extra: '{}', // 网页端建的记录没有 app 专属字段；app 上传时才会填
      updated_at: now,
    })
    bumpRev(uid)
    // 同步没取到标签才挂后台兜底（取到了 fillDetailLater 会二次检查自动跳过）
    if (bgmTags === '[]') fillDetailLater(uid, bgmId)
    return c.json(toJson(oneStmt.get(uid, bgmId) as TrackRow))
  }

  // ── 更新 —— 只写 body 里**明确给了**的字段；没给的一个都不碰 ──
  const sets: string[] = []
  const args: unknown[] = []

  if ('status' in body) {
    if (!STATUSES.includes(body.status as Status)) return c.json({ error: 'status 不合法' }, 400)
    sets.push('status = ?')
    args.push(body.status)
  }
  if ('episode' in body) {
    const n = Number(body.episode)
    if (!Number.isInteger(n) || n < 0) return c.json({ error: 'episode 不合法' }, 400)
    // 夹到总集数上限 —— 跟 app 的 normalize 一致（用户可能把总集数改小到已看集数以下）
    const total = 'totalEpisodes' in body ? asTotal(body.totalEpisodes) : prev.total_episodes
    sets.push('episode = ?')
    args.push(total != null && total > 0 ? Math.min(n, total) : n)
  }
  if ('totalEpisodes' in body) {
    const total = asTotal(body.totalEpisodes)
    if (total === undefined) return c.json({ error: 'totalEpisodes 不合法' }, 400)
    sets.push('total_episodes = ?')
    args.push(total)
    // 总集数改小了 → 已看集数跟着夹住（body 里没同时给 episode 时也要处理）
    if (total != null && !('episode' in body) && prev.episode > total) {
      sets.push('episode = ?')
      args.push(total)
    }
  }
  if ('userTags' in body) {
    const list = Array.isArray(body.userTags) ? body.userTags : null
    if (!list) return c.json({ error: 'userTags 不合法' }, 400)
    const clean = [...new Set(list.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean))]
    if (clean.length > USER_TAG_MAX_COUNT) return c.json({ error: `自定义标签最多 ${USER_TAG_MAX_COUNT} 个` }, 400)
    if (clean.some((t) => [...t].length > USER_TAG_MAX_LEN)) return c.json({ error: `单个标签最长 ${USER_TAG_MAX_LEN} 字` }, 400)
    sets.push('user_tags = ?')
    args.push(JSON.stringify(clean))
  }

  if (!sets.length) return c.json(toJson(prev))
  sets.push('updated_at = ?')
  args.push(now)
  db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE user_id = ? AND bgm_id = ?`).run(...args, uid, bgmId)
  bumpRev(uid)
  return c.json(toJson(oneStmt.get(uid, bgmId) as TrackRow))
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
  delStmt.run(uid, bgmId)
  bumpRev(uid)
  return c.json({ ok: true })
})

// ── app 同步（ideas/012「追番同步 · 落地决策」）──────────────────────────────────
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
  return c.json({ rev: currentRev(uid), data: (listStmt.all(uid) as TrackRow[]).map(toSyncJson) })
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

  const rev = currentRev(uid)
  if (body.force !== true && Number(body.baseRev) !== rev) {
    return c.json(
      { error: '服务器上有你还没拉取过的改动', rev, conflict: true, serverCount: (listStmt.all(uid) as TrackRow[]).length },
      409
    )
  }

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
    const existing = new Map((listStmt.all(uid) as TrackRow[]).map((r) => [r.bgm_id, r]))

    for (const [id, t] of incoming) {
      // 客户端时钟可能不准；未来的时间会让这条永远排在列表最前，夹到 now 为止
      const ts = Number(t.updatedAt)
      const updatedAt = Number.isFinite(ts) && ts > 0 ? Math.min(ts, now) : now

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
          air_weekday: Number(t.airWeekday) || 0,
          air_date: String(t.airDate ?? ''),
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
      if ('cover' in t) put('cover', String(t.cover ?? ''))
      if ('airWeekday' in t) put('air_weekday', Number(t.airWeekday) || 0)
      if ('airDate' in t) put('air_date', String(t.airDate ?? ''))
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
  })
  apply()

  return c.json({ rev: currentRev(uid), count: incoming.size })
})

export default tracks
