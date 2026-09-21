// 备份导入导出 —— 用户把自己的追番 + 点评 / 推荐带走一份，服务器炸了也能导回来。
// 意图与取舍见 docs/intent/web-import-export.md，这里只写代码没法自解释的部分。
//
//   票据  POST /api/backup/export-ticket {format} → { url }
//         下载管理器插件（NDM 之类）会把 http 下载链接抢去自己请求、不带本站 Cookie；给它一张 2 分钟
//         有效、只认导出的 JWT 票据挂在 URL 上，它才下得动。没装插件时浏览器自己下，行为一样。
//   导出  GET  /api/backup/export?format=zip|zip-md|md[&ticket=…]
//         zip 内：data.json（可导回）+ covers/<bgmId>.<ext>（仅本地上传封面）+ README.md（zip-md 时）
//         md   ：只供人读，不能导回
//   导入  POST /api/backup/import  multipart `file`，.zip 或裸 data.json
//
// 合并规则：按条目、后写者胜（同 bgm_id 比 updated_at），文件有账号没有的补上，账号有文件
// 没有的不动 —— 和 /api/tracks/sync 的「整包覆盖」是两回事，绝不删任何一条。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate'
import { db } from './db'
import { sign, verify } from 'hono/jwt'
import { getSession, rateLimited } from './auth'
import { AUTH_SECRET } from './secrets'
import { trackInternals as T, type TrackRow } from './tracks'
import { reviewInternals as R, type ContentRow, type DraftRow } from './reviews'
import type { ReviewMode, Spoiler } from './ai'

const backup = new Hono()

const FORMAT = 'mapletools-backup'
const VERSION = 1
const IMPORT_MAX_BYTES = 20 * 1024 * 1024 // 与 nginx client_max_body_size 对齐
const EXPORT_COVERS_MAX_BYTES = 200 * 1024 * 1024 // 一次性在内存里打包，给个保险
const STATUS_LABEL: Record<string, string> = { watching: '在追', plan: '想看', considering: '观望', done: '看完' }
const STATUS_ORDER = ['watching', 'plan', 'considering', 'done']
const MODE_LABEL: Record<ReviewMode, string> = { review: '点评', recommend: '推荐' }
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

type Status = (typeof T.STATUSES)[number]

// ── 导出 ─────────────────────────────────────────────────────────────────────
interface ExportTrack extends Record<string, unknown> {
  bgmId: number
  coverFile?: string
}
interface ExportReview {
  bgmId: number
  mode: ReviewMode
  content: Record<string, unknown> | null
  draft: Record<string, unknown> | null
}

const listContentsStmt = db.prepare<[number]>('SELECT * FROM review_contents WHERE user_id = ? ORDER BY bgm_id, mode')
const listDraftsStmt = db.prepare<[number]>('SELECT * FROM review_drafts WHERE user_id = ? ORDER BY bgm_id, mode')
const oneTrackStmt = db.prepare<[number, number]>('SELECT * FROM tracks WHERE user_id = ? AND bgm_id = ?')

function collect(uid: number): { tracks: ExportTrack[]; covers: Record<string, Uint8Array>; reviews: ExportReview[] } {
  const covers: Record<string, Uint8Array> = {}
  let coverBytes = 0
  const tracks: ExportTrack[] = []
  for (const row of T.listByInsertStmt.all(uid) as TrackRow[]) {
    const item: ExportTrack = { ...T.toJson(row), bgmId: row.bgm_id, extra: T.parseExtra(row.extra) }
    if (row.cover_mime) {
      // 本地封面：DB 里 cover 是哨兵路径、原网址早就不保留了。导出时 cover 置空 + coverFile 指向包内文件；
      // 导回缺图就走「cover 为空 → 周历回填」。文件读不到（盘上丢了）就当没图，不让整个导出失败。
      const ext = EXT_BY_MIME[row.cover_mime] ?? 'bin'
      try {
        const bytes = readFileSync(T.coverFilePath(uid, row.bgm_id))
        coverBytes += bytes.byteLength
        if (coverBytes > EXPORT_COVERS_MAX_BYTES) throw new Error('covers-too-large')
        const name = `covers/${row.bgm_id}.${ext}`
        covers[name] = new Uint8Array(bytes)
        item.coverFile = name
      } catch (e) {
        if ((e as Error).message === 'covers-too-large') throw e
      }
      item.cover = ''
    }
    tracks.push(item)
  }

  const byKey = new Map<string, ExportReview>()
  const slot = (bgmId: number, mode: ReviewMode): ExportReview => {
    const key = `${bgmId}:${mode}`
    let item = byKey.get(key)
    if (!item) {
      item = { bgmId, mode, content: null, draft: null }
      byKey.set(key, item)
    }
    return item
  }
  for (const row of listContentsStmt.all(uid) as (ContentRow & { bgm_id: number; mode: ReviewMode })[]) {
    slot(row.bgm_id, row.mode).content = R.contentJson(row)
  }
  for (const row of listDraftsStmt.all(uid) as (DraftRow & { bgm_id: number; mode: ReviewMode })[]) {
    slot(row.bgm_id, row.mode).draft = R.draftJson(row)
  }
  return { tracks, covers, reviews: [...byKey.values()] }
}

// 鉴赏神回集号折成「1、4-5、16-17」，与前端 compressGoodEpisodes 同一套规则。
function compressEpisodes(eps: number[]): string {
  const parts: string[] = []
  let start = -1
  let prev = -1
  for (const ep of eps) {
    if (start < 0) {
      start = prev = ep
      continue
    }
    if (ep === prev + 1) {
      prev = ep
      continue
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`)
    start = prev = ep
  }
  if (start >= 0) parts.push(start === prev ? String(start) : `${start}-${prev}`)
  return parts.join('、')
}

const cell = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim() || '–'
const fmtDate = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const SUBJECT_LABEL: Record<string, string> = { manga: '漫画', novel: '小说', other: '其他' }

function buildMarkdown(username: string, exportedAt: number, tracks: ExportTrack[], reviews: ExportReview[]): string {
  const name = (t: ExportTrack): string => String(t.titleCn || t.title || `#${t.bgmId}`)
  const out: string[] = []
  out.push(`# ${username} 的追番备份`, '', `导出时间：${fmtDate(exportedAt)}`, '')
  const counts = STATUS_ORDER.map((s) => `${STATUS_LABEL[s]} ${tracks.filter((t) => t.status === s).length}`).join(' · ')
  out.push(`共 ${tracks.length} 部：${counts}`, '')
  out.push('> 这份 Markdown 只供阅读；要恢复数据请导入同一次导出的 ZIP（或其中的 data.json）。', '')

  for (const status of STATUS_ORDER) {
    const group = tracks.filter((t) => t.status === status)
    if (!group.length) continue
    out.push(`## ${STATUS_LABEL[status]}（${group.length}）`, '')
    out.push('| 番名 | 进度 | 评分 | 最爱 | 标签 | 鉴赏神回 |', '|---|---|---|---|---|---|')
    const notes: string[] = []
    for (const t of group) {
      const type = SUBJECT_LABEL[String(t.subjectType)]
      const title = type ? `${name(t)}（${type}）` : name(t)
      const total = t.totalEpisodes == null ? '' : ` / ${t.totalEpisodes}`
      const fav = Number(t.favorite) > 0 ? '★'.repeat(Number(t.favorite)) : '–'
      const tags = (t.userTags as string[]).join('、')
      const eps = t.goodEpisodes as number[]
      out.push(`| ${cell(title)} | EP ${t.episode}${total} | ${Number(t.score) || '–'} | ${fav} | ${cell(tags)} | ${cell(compressEpisodes(eps))} |`)
      const epNotes = t.goodEpisodeNotes as Record<number, string>
      const keys = Object.keys(epNotes)
      if (keys.length) {
        notes.push(`- **${name(t)}**`)
        for (const k of keys) notes.push(`  - 第 ${k} 集：${epNotes[Number(k)]}`)
      }
    }
    out.push('')
    if (notes.length) out.push('鉴赏神回备注：', '', ...notes, '')
  }

  const titled = reviews
    .map((r) => ({ r, track: tracks.find((t) => t.bgmId === r.bgmId) }))
    .filter(({ r }) => (r.content && String(r.content.body).trim()) || (r.draft && String(r.draft.body).trim()))
    .sort((a, b) => (a.track ? name(a.track) : '').localeCompare(b.track ? name(b.track) : '', 'zh'))
  if (titled.length) {
    out.push('## 点评与推荐', '')
    for (const { r, track } of titled) {
      out.push(`### ${track ? name(track) : `#${r.bgmId}`} · ${MODE_LABEL[r.mode]}`, '')
      const body = r.content ? String(r.content.body).trim() : ''
      if (body) {
        const published = r.content!.published === true
        const at = typeof r.content!.publishedAt === 'number' ? ` · ${fmtDate(r.content!.publishedAt as number)}` : ''
        out.push(published ? `已公开${at}` : '未公开', '', body, '')
      }
      const draft = r.draft ? String(r.draft.body).trim() : ''
      if (draft && draft !== body) out.push('**草稿**', '', draft, '')
    }
  }
  return out.join('\n')
}

const dateStamp = (): string => fmtDate(Date.now()).slice(0, 10)
// 中文文件名走 RFC 5987 的 filename*；不认它的老客户端拿 ASCII 那份。
function attachment(c: Context, body: Uint8Array | string, type: string, filename: string, ascii: string): Response {
  c.header('Content-Type', type)
  c.header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  c.header('Cache-Control', 'no-store')
  return c.body(typeof body === 'string' ? body : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
}

const EXPORT_FORMATS = ['zip', 'zip-md', 'md'] as const
type ExportFormat = (typeof EXPORT_FORMATS)[number]
const TICKET_TTL_SEC = 120

interface ExportTicket {
  uid: number
  username: string
  format: ExportFormat
  scope: 'backup-export'
  exp: number
}

backup.post('/export-ticket', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { format?: unknown }
  if (!EXPORT_FORMATS.includes(body.format as ExportFormat)) return c.json({ error: 'format 不受支持' }, 400)
  const ticket: ExportTicket = {
    uid: session.uid,
    username: session.username,
    format: body.format as ExportFormat,
    scope: 'backup-export',
    exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SEC,
  }
  const token = await sign({ ...ticket }, AUTH_SECRET, 'HS256')
  return c.json({ url: `/api/backup/export?format=${ticket.format}&ticket=${encodeURIComponent(token)}`, expiresIn: TICKET_TTL_SEC })
})

async function exportIdentity(c: Context): Promise<{ uid: number; username: string } | null> {
  const ticket = c.req.query('ticket')
  if (!ticket) {
    const session = await getSession(c)
    return session ? { uid: session.uid, username: session.username } : null
  }
  try {
    const payload = (await verify(ticket, AUTH_SECRET, 'HS256')) as unknown as Partial<ExportTicket>
    if (payload.scope !== 'backup-export' || !Number.isInteger(payload.uid) || typeof payload.username !== 'string') return null
    // 票据锁定形态：拿着 md 的票改 query 要 zip 不行
    if (payload.format !== c.req.query('format')) return null
    return { uid: payload.uid as number, username: payload.username }
  } catch {
    return null
  }
}

backup.get('/export', async (c) => {
  const session = await exportIdentity(c)
  if (!session) return c.json({ error: '未登录或下载票据已过期' }, 401)
  if (rateLimited(`backup-export:${session.uid}`, 30, 10 * 60 * 1000)) return c.json({ error: '导出太频繁，稍后再试' }, 429)
  const format = c.req.query('format') ?? 'zip'
  if (!EXPORT_FORMATS.includes(format as ExportFormat)) return c.json({ error: 'format 不受支持' }, 400)

  let data: ReturnType<typeof collect>
  try {
    data = collect(session.uid)
  } catch (e) {
    if ((e as Error).message === 'covers-too-large') return c.json({ error: '本地封面总量超过 200MB，暂不支持一次导出' }, 413)
    throw e
  }
  const exportedAt = Date.now()
  const stamp = dateStamp()
  if (format === 'md') {
    const md = buildMarkdown(session.username, exportedAt, data.tracks, data.reviews)
    return attachment(c, md, 'text/markdown; charset=utf-8', `mapletools-追番-${stamp}.md`, `mapletools-tracks-${stamp}.md`)
  }
  const json = JSON.stringify(
    {
      format: FORMAT,
      version: VERSION,
      exportedAt,
      exportedBy: { userId: session.uid, username: session.username },
      tracks: data.tracks,
      reviews: data.reviews,
    },
    null,
    2,
  )
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    'data.json': [strToU8(json), { level: 6 }],
  }
  if (format === 'zip-md') {
    files['README.md'] = [strToU8(buildMarkdown(session.username, exportedAt, data.tracks, data.reviews)), { level: 6 }]
  }
  for (const [name, bytes] of Object.entries(data.covers)) files[name] = [bytes, { level: 0 }]
  return attachment(c, zipSync(files), 'application/zip', `mapletools-备份-${stamp}.zip`, `mapletools-backup-${stamp}.zip`)
})

// ── 导入 ─────────────────────────────────────────────────────────────────────
function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

interface Unpacked {
  data: Record<string, unknown>
  /** 包内文件（已剥掉外层目录前缀）；裸 JSON 导入时为空 */
  files: Record<string, Uint8Array>
}

/** 解包：`__MACOSX/` 忽略；data.json 允许在根目录，或恰好套了一层目录（右键压缩文件夹的产物）。 */
function unpack(bytes: Uint8Array, filename: string): Unpacked | { error: string } {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  if (!isZip) {
    if (filename.toLowerCase().endsWith('.zip')) return { error: '这个文件不是有效的 ZIP' }
    try {
      const data = JSON.parse(strFromU8(bytes)) as unknown
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'JSON 顶层必须是对象' }
      return { data: data as Record<string, unknown>, files: {} }
    } catch {
      return { error: '文件既不是 ZIP 也不是 JSON' }
    }
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, { filter: (f) => !f.name.startsWith('__MACOSX/') && !f.name.includes('/._') && !f.name.endsWith('/') })
  } catch {
    return { error: 'ZIP 解压失败' }
  }
  let prefix = ''
  if (!entries['data.json']) {
    const nested = Object.keys(entries).filter((n) => /^[^/]+\/data\.json$/.test(n))
    if (nested.length !== 1) return { error: 'ZIP 里找不到 data.json（应在根目录）' }
    prefix = nested[0].slice(0, -'data.json'.length)
  }
  const files: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(entries)) {
    if (name.startsWith(prefix)) files[name.slice(prefix.length)] = content
  }
  try {
    const data = JSON.parse(strFromU8(files['data.json'])) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'data.json 顶层必须是对象' }
    return { data: data as Record<string, unknown>, files }
  } catch {
    return { error: 'data.json 不是合法的 JSON' }
  }
}

interface IncomingTrack {
  bgmId: number
  status: Status
  episode: number
  totalEpisodes: number | null
  title: string
  titleCn: string
  cover: string
  airWeekday: number
  airDate: string
  score: number
  bgmTags: string[]
  userTags: string[]
  aliases: string[]
  extra: Record<string, unknown>
  observeCount: number
  updatedAt: number
  coverBytes: Uint8Array | null
  coverMime: string
  coverMissing: boolean
}

const strList = (v: unknown, maxLen: number, maxCount: number): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, maxLen)).filter(Boolean).slice(0, maxCount)
    : []
const asInt = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isInteger(n) ? n : fallback
}

function readTracks(raw: unknown, files: Record<string, Uint8Array>, now: number): IncomingTrack[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'tracks 必须是数组' }
  if (raw.length > T.MAX_TRACKS) return { error: `一次最多导入 ${T.MAX_TRACKS} 条追番` }
  const out: IncomingTrack[] = []
  const seen = new Set<number>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: '追番记录格式不对' }
    const t = item as Record<string, unknown>
    const bgmId = Number(t.bgmId)
    if (!Number.isInteger(bgmId) || bgmId === 0) return { error: `bgmId 不合法：${String(t.bgmId)}` }
    if (seen.has(bgmId)) return { error: `bgmId 重复：${bgmId}` }
    seen.add(bgmId)
    if (!T.STATUSES.includes(t.status as Status)) return { error: `条目 ${bgmId} 的 status 不受支持：${String(t.status)}` }
    const extra = t.extra && typeof t.extra === 'object' && !Array.isArray(t.extra) ? (t.extra as Record<string, unknown>) : {}
    if (JSON.stringify(extra).length > T.MAX_EXTRA_BYTES) return { error: `条目 ${bgmId} 的 extra 过大` }
    const ts = Number(t.updatedAt)
    const total = t.totalEpisodes == null ? null : asInt(t.totalEpisodes, 0)

    // coverFile 只认 covers/ 下的裸文件名（防路径穿越）；找不到 / 不是图 / 太大都算「缺失」，回退网址，不拒绝整批。
    let coverBytes: Uint8Array | null = null
    let coverMime = ''
    let coverMissing = false
    if (typeof t.coverFile === 'string' && t.coverFile) {
      const ok = /^covers\/[A-Za-z0-9_.-]+$/.test(t.coverFile) ? files[t.coverFile] : undefined
      const mime = ok ? sniffImage(ok) : null
      if (ok && mime && T.COVER_UPLOAD_MIME.has(mime) && ok.byteLength <= T.COVER_UPLOAD_MAX_BYTES) {
        coverBytes = ok
        coverMime = mime
      } else {
        coverMissing = true
      }
    }
    const cover = typeof t.cover === 'string' ? t.cover : ''
    out.push({
      bgmId,
      status: t.status as Status,
      episode: Math.max(0, asInt(t.episode, 0)),
      totalEpisodes: total != null && total > 0 ? total : null,
      title: String(t.title ?? '').slice(0, 200),
      titleCn: String(t.titleCn ?? '').slice(0, 200),
      // 哨兵路径不能当网址导回：它只在配合 cover_mime 时才有意义
      cover: cover.startsWith('/api/') ? '' : cover.slice(0, 500),
      airWeekday: (() => { const w = asInt(t.airWeekday, 0); return w >= 1 && w <= 7 ? w : 0 })(),
      airDate: String(t.airDate ?? '').slice(0, 10),
      score: Number(t.score) || 0,
      bgmTags: strList(t.bgmTags, 40, 60),
      userTags: strList(t.userTags, 20, 12),
      aliases: strList(t.aliases, 100, 30),
      extra,
      observeCount: Math.max(0, asInt(t.observeCount, 0)),
      updatedAt: Number.isFinite(ts) && ts > 0 ? Math.min(ts, now) : now,
      coverBytes,
      coverMime,
      coverMissing,
    })
  }
  return out
}

interface IncomingReview {
  bgmId: number
  mode: ReviewMode
  content: {
    body: string
    episode: number
    spoiler: Spoiler
    tone: string
    length: string
    scoreShown: number
    tagsShown: string[]
    published: boolean
    publishedAt: number | null
    createdAt: number
    updatedAt: number
  } | null
  draft: {
    episode: number
    spoiler: Spoiler
    tone: string
    length: string
    questions: string
    answers: string
    body: string
    updatedAt: number
  } | null
}

function readReviews(raw: unknown, now: number): IncomingReview[] | { error: string } {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return { error: 'reviews 必须是数组' }
  if (raw.length > T.MAX_TRACKS * 2) return { error: '点评条数超出上限' }
  const out: IncomingReview[] = []
  const seen = new Set<string>()
  const clampTs = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.min(n, now) : now
  }
  const spoilerOf = (v: unknown): Spoiler => (R.SPOILERS.includes(v as Spoiler) ? (v as Spoiler) : 'none')
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: '点评记录格式不对' }
    const r = item as Record<string, unknown>
    const bgmId = Number(r.bgmId)
    if (!Number.isInteger(bgmId) || bgmId === 0) return { error: `点评的 bgmId 不合法：${String(r.bgmId)}` }
    if (!R.MODES.includes(r.mode as ReviewMode)) return { error: `点评 ${bgmId} 的 mode 不受支持：${String(r.mode)}` }
    const key = `${bgmId}:${String(r.mode)}`
    if (seen.has(key)) return { error: `点评重复：${key}` }
    seen.add(key)
    const c = r.content && typeof r.content === 'object' ? (r.content as Record<string, unknown>) : null
    const d = r.draft && typeof r.draft === 'object' ? (r.draft as Record<string, unknown>) : null
    const questions = d ? R.normalizeQuestions(d.questions) : []
    out.push({
      bgmId,
      mode: r.mode as ReviewMode,
      content: c
        ? {
            body: String(c.body ?? '').slice(0, R.BODY_MAX),
            episode: Math.max(0, asInt(c.episode, 0)),
            spoiler: spoilerOf(c.spoiler),
            tone: String(c.tone ?? '').slice(0, R.TONE_MAX),
            length: String(c.length ?? '').slice(0, R.LENGTH_MAX),
            scoreShown: Number(c.scoreShown) || 0,
            tagsShown: strList(c.tagsShown, 20, R.TAGS_SHOWN_MAX),
            published: c.published === true,
            publishedAt: c.published === true ? clampTs(c.publishedAt) : null,
            createdAt: clampTs(c.createdAt),
            updatedAt: clampTs(c.updatedAt),
          }
        : null,
      draft: d
        ? {
            episode: Math.max(0, asInt(d.episode, 0)),
            spoiler: spoilerOf(d.spoiler),
            tone: String(d.tone ?? '').slice(0, R.TONE_MAX),
            length: String(d.length ?? '').slice(0, R.LENGTH_MAX),
            questions: JSON.stringify(questions),
            answers: JSON.stringify(R.normalizeAnswers(d.answers, questions)),
            body: String(d.body ?? '').slice(0, R.BODY_MAX),
            updatedAt: clampTs(d.updatedAt),
          }
        : null,
    })
  }
  return out
}

const fullUpdateStmt = db.prepare(`
  UPDATE tracks
  SET status = @status, episode = @episode, total_episodes = @total_episodes,
      title = @title, title_cn = @title_cn, cover = @cover, cover_mime = @cover_mime,
      air_weekday = @air_weekday, air_date = @air_date, score = @score,
      bgm_tags = @bgm_tags, user_tags = @user_tags, aliases = @aliases, extra = @extra,
      observe_count = @observe_count, updated_at = @updated_at
  WHERE user_id = @user_id AND bgm_id = @bgm_id
`)

interface ImportSummary {
  tracks: { added: number; updated: number; skipped: number }
  reviews: { imported: number; skipped: number } | null
  covers: { imported: number; missing: number }
  foreignBackup: boolean
}

backup.post('/import', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const uid = session.uid
  if (rateLimited(`backup-import:${uid}`, 10, 10 * 60 * 1000)) return c.json({ error: '导入太频繁，稍后再试' }, 429)

  const body = await c.req.parseBody().catch(() => null)
  const file = body?.file
  if (!(file instanceof File)) return c.json({ error: '没有收到文件' }, 400)
  if (file.size > IMPORT_MAX_BYTES) return c.json({ error: '文件不能超过 20MB' }, 400)

  const unpacked = unpack(new Uint8Array(await file.arrayBuffer()), file.name)
  if ('error' in unpacked) return c.json({ error: unpacked.error }, 400)
  const { data, files } = unpacked
  if (data.format !== FORMAT) return c.json({ error: '这不是 MapleTools 导出的备份' }, 400)
  if (data.version !== VERSION) return c.json({ error: `备份版本 ${String(data.version)} 不受支持` }, 400)

  const now = Date.now()
  const tracksIn = readTracks(data.tracks, files, now)
  if ('error' in tracksIn) return c.json({ error: tracksIn.error }, 400)
  const exportedBy = data.exportedBy && typeof data.exportedBy === 'object' ? (data.exportedBy as Record<string, unknown>) : {}
  const foreignBackup = Number(exportedBy.userId) !== uid
  // 别人的备份只导追番：点评是署名内容，不能一键变成导入者自己公开发表的东西。
  const reviewsIn = foreignBackup ? [] : readReviews(data.reviews, now)
  if ('error' in reviewsIn) return c.json({ error: reviewsIn.error }, 400)

  const summary: ImportSummary = {
    tracks: { added: 0, updated: 0, skipped: 0 },
    reviews: foreignBackup ? null : { imported: 0, skipped: 0 },
    covers: { imported: 0, missing: tracksIn.filter((t) => t.coverMissing).length },
    foreignBackup,
  }

  // 封面文件在事务里同步写：决策（谁新谁旧）和落盘在同一把锁、同一个事务里，事务失败就把刚写的删掉。
  // 锁住所有带图的 bgmId，和上传 / 同步的封面操作串行，避免互相覆盖对方刚写的字节。
  const withCovers = tracksIn.filter((t) => t.coverBytes).map((t) => t.bgmId)
  await T.withCoverFileLocks(uid, withCovers, async () => {
    const written: number[] = []
    const apply = db.transaction(() => {
      written.length = 0
      summary.tracks = { added: 0, updated: 0, skipped: 0 }
      summary.reviews = foreignBackup ? null : { imported: 0, skipped: 0 }
      summary.covers.imported = 0
      const existing = new Map((T.listByInsertStmt.all(uid) as TrackRow[]).map((r) => [r.bgm_id, r]))
      for (const t of tracksIn) {
        const prev = existing.get(t.bgmId)
        if (prev && prev.updated_at >= t.updatedAt) {
          summary.tracks.skipped++
          continue
        }
        let cover = t.cover
        let coverMime = ''
        if (t.coverBytes) {
          writeFileSync(T.coverFilePath(uid, t.bgmId), t.coverBytes)
          written.push(t.bgmId)
          cover = T.coverSentinel(t.bgmId)
          coverMime = t.coverMime
          summary.covers.imported++
        } else if (prev?.cover_mime) {
          // 备份这条更新、却没带图（裸 JSON 导入或图坏了）：其余字段照备份走，但账号里已上传的封面留着，
          // 宁可图旧一点也不把用户上传的图删掉。
          cover = prev.cover
          coverMime = prev.cover_mime
        }
        const airWeekday = t.airWeekday || T.weekdayFromDate(t.airDate) || prev?.air_weekday || 0
        const row = {
          user_id: uid,
          bgm_id: t.bgmId,
          status: t.status,
          episode: t.episode,
          total_episodes: t.totalEpisodes,
          title: t.title,
          title_cn: t.titleCn,
          cover,
          cover_mime: coverMime,
          air_weekday: airWeekday,
          air_date: t.airDate || prev?.air_date || '',
          score: t.score,
          bgm_tags: JSON.stringify(t.bgmTags),
          user_tags: JSON.stringify(t.userTags),
          aliases: JSON.stringify(t.aliases),
          extra: JSON.stringify(t.extra),
          observe_count: t.observeCount,
          updated_at: t.updatedAt,
        }
        if (prev) {
          fullUpdateStmt.run(row)
          summary.tracks.updated++
        } else {
          // insertStmt 没有 cover_mime 列，插入后补一笔
          const { cover_mime: _mime, ...insertRow } = row
          T.insertStmt.run(insertRow)
          if (coverMime) db.prepare('UPDATE tracks SET cover_mime = ? WHERE user_id = ? AND bgm_id = ?').run(coverMime, uid, t.bgmId)
          summary.tracks.added++
        }
      }

      for (const r of reviewsIn) {
        // 点评挂在追番下：追番不在（备份里没有、或导入者删过）就跳过，不凭空造一条没有番的点评
        if (!oneTrackStmt.get(uid, r.bgmId)) {
          summary.reviews!.skipped++
          continue
        }
        let touched = false
        if (r.content) {
          const prev = R.contentStmt.get(uid, r.bgmId, r.mode) as ContentRow | undefined
          if (!prev || prev.updated_at < r.content.updatedAt) {
            R.upsertContentStmt.run({
              user_id: uid,
              bgm_id: r.bgmId,
              mode: r.mode,
              body: r.content.body,
              episode: r.content.episode,
              spoiler: r.content.spoiler,
              tone: r.content.tone,
              length: r.content.length,
              score_shown: r.content.scoreShown,
              tags_shown: JSON.stringify(r.content.tagsShown),
              published: r.content.published ? 1 : 0,
              published_at: r.content.publishedAt,
              created_at: prev?.created_at ?? r.content.createdAt,
              updated_at: r.content.updatedAt,
            })
            touched = true
          }
        }
        if (r.draft) {
          const prev = R.draftStmt.get(uid, r.bgmId, r.mode) as DraftRow | undefined
          if (!prev || prev.updated_at < r.draft.updatedAt) {
            R.upsertDraftStmt.run({
              user_id: uid,
              bgm_id: r.bgmId,
              mode: r.mode,
              episode: r.draft.episode,
              spoiler: r.draft.spoiler,
              tone: r.draft.tone,
              length: r.draft.length,
              questions: r.draft.questions,
              answers: r.draft.answers,
              body: r.draft.body,
              updated_at: r.draft.updatedAt,
            })
            touched = true
          }
        }
        if (touched) summary.reviews!.imported++
        else summary.reviews!.skipped++
      }

      if (summary.tracks.added || summary.tracks.updated) T.bumpRev(uid)
    })
    try {
      apply.immediate()
    } catch (e) {
      for (const id of written) {
        try {
          unlinkSync(T.coverFilePath(uid, id))
        } catch {
          /* 已经没了 */
        }
      }
      throw e
    }
  })

  if (summary.tracks.added || summary.tracks.updated) T.fillCalendarMetadataLater(uid)
  return c.json({ ...summary, statusCounts: T.statusCounts(uid) })
})

export default backup
