// 公开追番大厅 —— 只读取用户主动公开的动画追番列表。
//
// 这是一个明确按开关控制的公开投影：不返回用户 id / 邮箱，但用户追番里已经明确
// 允许分享的标签、好看集、收藏星级、播放源绑定和本地封面都会随公开页面展示。
// 追番表仍由 tracks.ts 按账号隔离，公开端点只从已开启 users.tracks_public 的账号读取。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from './db'
import { coversDir } from './data-dir'
import { bindingsFor as girigiriBindingsFor } from './girigiri/bindings'
import { bindingsFor as xifanBindingsFor } from './xifan/bindings'

const community = new Hono()

const MAX_USERS = 100
const MAX_PUBLIC_TEXT = 500
const PUBLIC_COVER_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

interface PublicUserRow {
  id: number
  username: string
}

interface PublicTrackRow {
  bgm_id: number
  status: string
  episode: number
  total_episodes: number | null
  title: string
  title_cn: string
  cover: string
  cover_mime: string
  air_date: string
  score: number
  bgm_tags: string
  user_tags: string
  aliases: string
  extra: string
}

const publicUsersStmt = db.prepare<[number]>(
  'SELECT id, username FROM users WHERE tracks_public = 1 ORDER BY id DESC LIMIT ?',
)
const publicUserStmt = db.prepare<[string]>(
  'SELECT id, username FROM users WHERE username = ? COLLATE NOCASE AND tracks_public = 1 LIMIT 1',
)
const publicTracksStmt = db.prepare<[number]>(
  `SELECT bgm_id, status, episode, total_episodes, title, title_cn, cover, cover_mime, air_date,
          score, bgm_tags, user_tags, aliases, extra
   FROM tracks
   WHERE user_id = ?
   ORDER BY id DESC`,
)
const publicCoverStmt = db.prepare<[number, number]>(
  'SELECT cover, cover_mime FROM tracks WHERE user_id = ? AND bgm_id = ?',
)

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 50)
      : []
  } catch {
    return []
  }
}

function parseExtra(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function subjectTypeOf(extra: Record<string, unknown>): string {
  return typeof extra.subjectType === 'string' ? extra.subjectType : 'anime'
}

function publicText(value: string, max = MAX_PUBLIC_TEXT): string {
  return [...value].slice(0, max).join('')
}

function publicCover(value: string, coverMime: string, username: string, bgmId: number): string {
  // 本地上传封面现在也属于用户主动公开的追番内容，但不能把只认当前会话的
  // /api/tracks 路径直接发出去；改成带公开用户名的只读路径，关闭开关后立即失效。
  if (coverMime && value === `/api/tracks/${bgmId}/cover-file`) {
    return `/api/community/${encodeURIComponent(username)}/${bgmId}/cover-file`
  }
  try {
    const url = new URL(value)
    // 公开页只使用无凭据的 HTTPS 图床；避免把 data:、带账号密码的地址或明文链接
    // 从用户私有记录带到公开响应里。
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    return publicText(url.toString(), 2000)
  } catch {
    return ''
  }
}

function normalizeGoodEpisodes(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  for (const raw of value) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) continue
    seen.add(n)
  }
  return [...seen].sort((a, b) => a - b).slice(0, 500)
}

function normalizeGoodEpisodeNotes(value: unknown, episodes: number[]): Record<number, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allowed = new Set(episodes)
  const out: Record<number, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const ep = Number(key)
    if (!allowed.has(ep) || typeof raw !== 'string') continue
    const note = raw.trim()
    if (note) out[ep] = publicText(note, 500)
    if (Object.keys(out).length >= 100) break
  }
  return out
}

function normalizeFavorite(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 6) : 0
}

interface PublicBindings {
  xifan: Record<number, { id: number; name: string }>
  girigiri: Record<number, { id: string; name: string }>
}

function toPublicTrack(row: PublicTrackRow, username: string, bindings: PublicBindings): Record<string, unknown> | null {
  const extra = parseExtra(row.extra)
  if (subjectTypeOf(extra) !== 'anime') return null
  const goodEpisodes = normalizeGoodEpisodes(extra.goodEpisodes)

  // 公开数据包含用户明确同意分享的追番字段，但不带账号身份 / 会话字段。
  return {
    bgmId: row.bgm_id,
    status: ['watching', 'plan', 'considering', 'done'].includes(row.status) ? row.status : 'watching',
    episode: Number.isInteger(row.episode) && row.episode >= 0 ? row.episode : 0,
    totalEpisodes: row.total_episodes,
    title: publicText(row.title),
    titleCn: publicText(row.title_cn),
    cover: publicCover(row.cover, row.cover_mime, username, row.bgm_id),
    airDate: publicText(row.air_date, 32),
    score: Number.isFinite(row.score) ? row.score : 0,
    bgmTags: parseList(row.bgm_tags).map((tag) => publicText(tag, 80)),
    userTags: parseList(row.user_tags).slice(0, 20).map((tag) => publicText(tag, 80)),
    aliases: parseList(row.aliases).map((alias) => publicText(alias, 200)),
    goodEpisodes,
    goodEpisodeNotes: normalizeGoodEpisodeNotes(extra.goodEpisodeNotes, goodEpisodes),
    favorite: normalizeFavorite(extra.favorite),
    bindings: {
      xifan: bindings.xifan[row.bgm_id] ?? null,
      girigiri: bindings.girigiri[row.bgm_id] ?? null,
    },
  }
}

function rowsForUser(userId: number): PublicTrackRow[] {
  return publicTracksStmt.all(userId) as PublicTrackRow[]
}

function publicTrackCount(userId: number): number {
  return rowsForUser(userId)
    .map((row) => subjectTypeOf(parseExtra(row.extra)))
    .filter((type) => type === 'anime')
    .length
}

function tracksForUser(userId: number, username: string): Record<string, unknown>[] {
  const rows = rowsForUser(userId)
  const ids = rows.map((row) => row.bgm_id)
  const bindings: PublicBindings = {
    xifan: Object.fromEntries(
      Object.entries(xifanBindingsFor(ids)).map(([id, binding]) => [id, { id: binding.xifanId, name: publicText(binding.xifanName, 200) }]),
    ),
    girigiri: Object.fromEntries(
      Object.entries(girigiriBindingsFor(ids)).map(([id, binding]) => [id, { id: binding.girigiriId, name: publicText(binding.girigiriName, 200) }]),
    ),
  }
  return rows
    .map((row) => toPublicTrack(row, username, bindings))
    .filter((track): track is Record<string, unknown> => track !== null)
}

function publicHeaders(c: Context): void {
  // 公开内容仍不进入浏览器 / 反代缓存：关闭公开开关后，撤回应立即生效。
  c.header('Cache-Control', 'no-store')
}

// 大厅不要求登录；只筛选明确打开公开开关的账号，最多取 100 个，避免匿名列表无限增长。
community.get('/', (c) => {
  publicHeaders(c)
  const requested = Number(c.req.query('limit'))
  const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), MAX_USERS) : MAX_USERS
  const rows = publicUsersStmt.all(limit + 1) as PublicUserRow[]
  const data = rows.slice(0, limit).map((user) => ({
    username: user.username,
    trackCount: publicTrackCount(user.id),
  }))
  return c.json({ data, hasMore: rows.length > limit })
})

// 本地封面不能复用只认当前会话的 tracks 路径；这里重新检查公开开关，让撤回公开后旧地址也失效。
community.get('/:username/:bgmId/cover-file', async (c) => {
  publicHeaders(c)
  const username = c.req.param('username').trim()
  const bgmId = Number(c.req.param('bgmId'))
  if (!username || !Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: '公开封面不存在' }, 404)
  const user = publicUserStmt.get(username) as PublicUserRow | undefined
  if (!user) return c.json({ error: '公开封面不存在' }, 404)
  const row = publicCoverStmt.get(user.id, bgmId) as { cover: string; cover_mime: string } | undefined
  if (!row || row.cover !== `/api/tracks/${bgmId}/cover-file` || !row.cover_mime) {
    return c.json({ error: '公开封面不存在' }, 404)
  }
  if (!PUBLIC_COVER_MIME.has(row.cover_mime)) {
    return c.json({ error: '公开封面不存在' }, 404)
  }
  try {
    const bytes = await readFile(join(coversDir, `${user.id}_${bgmId}`))
    c.header('Content-Type', row.cover_mime)
    return c.body(bytes)
  } catch {
    return c.json({ error: '公开封面不存在' }, 404)
  }
})

// 私有账号和不存在的账号统一 404，避免通过响应差异探测账号是否存在。
community.get('/:username', (c) => {
  publicHeaders(c)
  const username = c.req.param('username').trim()
  if (!username || username.length > 200 || /[\u0000-\u001f\u007f]/.test(username)) {
    return c.json({ error: '公开用户不存在' }, 404)
  }
  const user = publicUserStmt.get(username) as PublicUserRow | undefined
  if (!user) return c.json({ error: '公开用户不存在' }, 404)
  const data = tracksForUser(user.id, user.username)
  return c.json({ user: { username: user.username, trackCount: data.length }, data })
})

export default community
