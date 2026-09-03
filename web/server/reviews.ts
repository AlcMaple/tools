// 推荐与点评助手 —— 用户数据，必须登录。
//
// 每 (user_id, bgm_id, mode) 至多：一份草稿（review_drafts）+ 一份「当前内容」（review_contents）。
// mode 只有 review（观后点评）/ recommend（推荐文）。两模式完全独立，重新提交只覆盖对应模式。
//
// AI 来源两条路都汇到这里：
//   - 服务器 AI：questions / generate 接口内部调 server/ai.ts
//   - BYOK：前端拿 /material 自己调，再把 questions / body 通过 PUT /draft 回存
// 草稿跨设备恢复只依赖本表，与 AI 来源无关。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { fetchJson } from './http'
import { db } from './db'
import { getSession, rateLimited } from './auth'
import {
  generateDraftStream,
  generateQuestions,
  MaterialTooLargeError,
  type Material,
  type ReviewMode,
  type Spoiler,
  type WritingOpts,
} from './ai'

const reviews = new Hono()

const MODES: ReviewMode[] = ['review', 'recommend']
const SPOILERS: Spoiler[] = ['none', 'aired', 'all']
const BODY_MAX = 4000
const TONE_MAX = 20
const LENGTH_MAX = 20
const QUESTION_MAX = 200
const TAGS_SHOWN_MAX = 20

async function requireUid(c: Context): Promise<number | null> {
  const s = await getSession(c)
  return s?.uid ?? null
}

const isMode = (v: string): v is ReviewMode => (MODES as string[]).includes(v)
const isSpoiler = (v: unknown): v is Spoiler => typeof v === 'string' && (SPOILERS as string[]).includes(v)

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

// 问题一律是选择题：{ q, options[], multi }。答案是 { picks: {题号:[选中选项]}, custom: {题号:手打补充} }。
interface DraftQuestion {
  q: string
  options: string[]
  multi: boolean
}
interface DraftAnswers {
  picks: Record<string, string[]>
  custom: Record<string, string>
}
const EMPTY_ANSWERS: DraftAnswers = { picks: {}, custom: {} }

function normalizeQuestions(value: unknown): DraftQuestion[] {
  const arr = typeof value === 'string' ? (() => { try { return JSON.parse(value || '[]') } catch { return [] } })() : value
  if (!Array.isArray(arr)) return []
  const out: DraftQuestion[] = []
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const q = typeof item.q === 'string' ? item.q.trim().slice(0, QUESTION_MAX) : ''
    const options = Array.isArray(item.options)
      ? item.options.map((o) => (typeof o === 'string' ? o.trim().slice(0, 120) : '')).filter(Boolean).slice(0, 6)
      : []
    if (!q || options.length < 2) continue
    out.push({ q, options, multi: item.multi === true })
    if (out.length >= 6) break
  }
  return out
}

function normalizeAnswers(value: unknown, questions: DraftQuestion[]): DraftAnswers {
  let obj: Record<string, unknown> = {}
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>
  } catch {
    return { ...EMPTY_ANSWERS }
  }
  const picks: Record<string, string[]> = {}
  const rawPicks = obj.picks && typeof obj.picks === 'object' && !Array.isArray(obj.picks)
    ? (obj.picks as Record<string, unknown>)
    : {}
  const custom: Record<string, string> = {}
  const rawCustom = obj.custom && typeof obj.custom === 'object' && !Array.isArray(obj.custom)
    ? (obj.custom as Record<string, unknown>)
    : {}
  questions.forEach((quest, i) => {
    const chosen = Array.isArray(rawPicks[String(i)]) ? (rawPicks[String(i)] as unknown[]) : []
    const allowed = chosen
      .filter((x): x is string => typeof x === 'string' && quest.options.includes(x))
      .slice(0, quest.multi ? quest.options.length : 1)
    if (allowed.length) picks[String(i)] = allowed
    const c = rawCustom[String(i)]
    if (typeof c === 'string' && c.trim()) custom[String(i)] = c.slice(0, 500)
  })
  return { picks, custom }
}

// ── 该用户是否追了这部番（点评 / 推荐都要求追番存在）──────────────────────────
interface TrackRow {
  status: string
  episode: number
  total_episodes: number | null
  title: string
  title_cn: string
  user_tags: string
  score: number
  extra: string
}
const trackStmt = db.prepare<[number, number]>(
  'SELECT status, episode, total_episodes, title, title_cn, user_tags, score, extra FROM tracks WHERE user_id = ? AND bgm_id = ?',
)

/** 从 tracks.extra 里取用户写过的好看集备注（他自己的只言片语）。 */
function goodEpisodeNotesOf(extra: string): string[] {
  try {
    const ex = JSON.parse(extra || '{}') as Record<string, unknown>
    const notes = ex.goodEpisodeNotes
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return []
    return Object.entries(notes as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' && (v as string).trim())
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([ep, v]) => `第 ${ep} 集：${(v as string).trim().slice(0, 200)}`)
      .slice(0, 12)
  } catch {
    return []
  }
}

// ── 预编译语句 ───────────────────────────────────────────────────────────────
interface DraftRow {
  episode: number
  spoiler: Spoiler
  tone: string
  length: string
  questions: string
  answers: string
  body: string
  updated_at: number
}
interface ContentRow {
  body: string
  episode: number
  spoiler: Spoiler
  tone: string
  length: string
  score_shown: number
  tags_shown: string
  published: number
  published_at: number | null
  created_at: number
  updated_at: number
}

const draftStmt = db.prepare<[number, number, string]>(
  'SELECT * FROM review_drafts WHERE user_id = ? AND bgm_id = ? AND mode = ?',
)
const contentStmt = db.prepare<[number, number, string]>(
  'SELECT * FROM review_contents WHERE user_id = ? AND bgm_id = ? AND mode = ?',
)
const deleteDraftStmt = db.prepare<[number, number, string]>(
  'DELETE FROM review_drafts WHERE user_id = ? AND bgm_id = ? AND mode = ?',
)
const deleteContentStmt = db.prepare<[number, number, string]>(
  'DELETE FROM review_contents WHERE user_id = ? AND bgm_id = ? AND mode = ?',
)
const upsertDraftStmt = db.prepare(`
  INSERT INTO review_drafts (user_id, bgm_id, mode, episode, spoiler, tone, length, questions, answers, body, updated_at)
  VALUES (@user_id, @bgm_id, @mode, @episode, @spoiler, @tone, @length, @questions, @answers, @body, @updated_at)
  ON CONFLICT(user_id, bgm_id, mode) DO UPDATE SET
    episode = @episode, spoiler = @spoiler, tone = @tone, length = @length,
    questions = @questions, answers = @answers, body = @body, updated_at = @updated_at
`)
const upsertContentStmt = db.prepare(`
  INSERT INTO review_contents
    (user_id, bgm_id, mode, body, episode, spoiler, tone, length, score_shown, tags_shown,
     published, published_at, created_at, updated_at)
  VALUES
    (@user_id, @bgm_id, @mode, @body, @episode, @spoiler, @tone, @length, @score_shown, @tags_shown,
     @published, @published_at, @created_at, @updated_at)
  ON CONFLICT(user_id, bgm_id, mode) DO UPDATE SET
    body = @body, episode = @episode, spoiler = @spoiler, tone = @tone, length = @length,
    score_shown = @score_shown, tags_shown = @tags_shown,
    published = @published, published_at = @published_at, updated_at = @updated_at
`)
const setPublishedStmt = db.prepare<[number, number | null, number, number, number, string]>(
  'UPDATE review_contents SET published = ?, published_at = ?, updated_at = ? WHERE user_id = ? AND bgm_id = ? AND mode = ?',
)

// ── 序列化 ───────────────────────────────────────────────────────────────────
function draftJson(r: DraftRow | undefined): Record<string, unknown> | null {
  if (!r) return null
  return {
    episode: r.episode,
    spoiler: r.spoiler,
    tone: r.tone,
    length: r.length,
    questions: normalizeQuestions(r.questions),
    answers: normalizeAnswers(r.answers, normalizeQuestions(r.questions)),
    body: r.body,
    updatedAt: r.updated_at,
  }
}
function contentJson(r: ContentRow | undefined): Record<string, unknown> | null {
  if (!r) return null
  return {
    body: r.body,
    episode: r.episode,
    spoiler: r.spoiler,
    tone: r.tone,
    length: r.length,
    scoreShown: r.score_shown,
    tagsShown: parseList(r.tags_shown),
    published: r.published === 1,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function modeState(uid: number, bgmId: number, mode: ReviewMode): Record<string, unknown> {
  return {
    draft: draftJson(draftStmt.get(uid, bgmId, mode) as DraftRow | undefined),
    content: contentJson(contentStmt.get(uid, bgmId, mode) as ContentRow | undefined),
  }
}

// ── BGM 资料组装（服务端读 BGM，前端 / BYOK 都不碰 BGM）──────────────────────
const BGM_HEADERS = {
  'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)',
  Accept: 'application/json',
}

function infoboxValue(infobox: unknown, key: string): string[] {
  if (!Array.isArray(infobox)) return []
  const out: string[] = []
  for (const raw of infobox) {
    const item = raw as { key?: unknown; value?: unknown }
    if (item.key !== key) continue
    if (typeof item.value === 'string') out.push(item.value)
    else if (Array.isArray(item.value)) {
      for (const v of item.value) {
        const s = (v as { v?: unknown }).v
        if (typeof s === 'string' && s.trim()) out.push(s.trim())
      }
    }
  }
  return out
}

async function buildMaterial(bgmId: number, track: TrackRow): Promise<Material> {
  let raw: Record<string, unknown> = {}
  try {
    raw = (await fetchJson(`https://api.bgm.tv/v0/subjects/${bgmId}`, {
      headers: BGM_HEADERS,
      timeoutMs: 10000,
    })) as Record<string, unknown>
  } catch {
    // BGM 抖动不阻断：用追番表里已有的标题兜底，资料少一点，用户仍能生成 / 手写
  }
  const infobox = raw.infobox
  const rating = (raw.rating ?? {}) as Record<string, unknown>
  const tags = Array.isArray(raw.tags)
    ? (raw.tags as { name?: unknown }[])
        .map((t) => (typeof t.name === 'string' ? t.name : ''))
        .filter(Boolean)
        .slice(0, 12)
    : []
  const staff = [
    ...infoboxValue(infobox, '导演').map((v) => `导演：${v}`),
    ...infoboxValue(infobox, '原作').map((v) => `原作：${v}`),
    ...infoboxValue(infobox, '动画制作').map((v) => `动画制作：${v}`),
    ...infoboxValue(infobox, '系列构成').map((v) => `系列构成：${v}`),
  ].slice(0, 6)
  return {
    bgmId,
    title: (typeof raw.name === 'string' && raw.name) || track.title,
    titleCn: (typeof raw.name_cn === 'string' && raw.name_cn) || track.title_cn,
    type: infoboxValue(infobox, '话数').length ? '动画' : '动画',
    platform: typeof raw.platform === 'string' ? raw.platform : '',
    eps: Number(raw.total_episodes) || Number(raw.eps) || track.total_episodes || 0,
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 8000) : '',
    tags,
    score: Number(rating.score) || track.score || 0,
    staff,
    goodEpisodeNotes: goodEpisodeNotesOf(track.extra),
  }
}

// ── 请求体归一 ───────────────────────────────────────────────────────────────
function readWritingOpts(body: Record<string, unknown>, track: TrackRow): WritingOpts | { error: string } {
  const status = track.status === 'done' ? 'done' : 'watching'
  const spoiler = isSpoiler(body.spoiler) ? body.spoiler : 'none'
  const tone = typeof body.tone === 'string' ? body.tone.slice(0, TONE_MAX) : ''
  const length = typeof body.length === 'string' ? body.length.slice(0, LENGTH_MAX) : ''
  let episode = Number(body.episode)
  if (!Number.isInteger(episode) || episode < 0) episode = track.episode
  if (status === 'watching' && track.total_episodes != null) {
    episode = Math.min(episode, track.total_episodes)
  }
  return { mode: 'review', tone, length, spoiler, episode, status }
}

function readMaterialExtras(m: Material, body: Record<string, unknown>): void {
  const score = Number(body.userScore)
  if (Number.isFinite(score) && score > 0) m.userScore = Math.min(10, score)
  if (Array.isArray(body.userTags)) {
    m.userTags = body.userTags.filter((x): x is string => typeof x === 'string').slice(0, TAGS_SHOWN_MAX)
  }
  if (typeof body.episodeNote === 'string' && body.episodeNote.trim()) {
    m.userEpisodeNote = body.episodeNote.slice(0, 500)
  }
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = (await c.req.json()) as unknown
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

// 路径参数校验 —— 返回 track 行或错误。
function loadTrack(uid: number, bgmIdRaw: string, modeRaw: string): { bgmId: number; mode: ReviewMode; track: TrackRow } | { error: string; status: 400 | 404 } {
  const bgmId = Number(bgmIdRaw)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return { error: 'bgmId 不合法', status: 400 }
  if (!isMode(modeRaw)) return { error: 'mode 不合法', status: 400 }
  const track = trackStmt.get(uid, bgmId) as TrackRow | undefined
  if (!track) return { error: '你还没追这部番', status: 404 }
  if (track.status !== 'done' && track.status !== 'watching') {
    return { error: '还没看的番，写不了点评啦', status: 400 }
  }
  return { bgmId, mode: modeRaw, track }
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

// 该番两模式的完整状态（草稿 + 当前内容）
reviews.get('/:bgmId', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const bgmId = Number(c.req.param('bgmId'))
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  const track = trackStmt.get(uid, bgmId) as TrackRow | undefined
  return c.json({
    track: track
      ? { status: track.status, episode: track.episode, totalEpisodes: track.total_episodes }
      : null,
    review: modeState(uid, bgmId, 'review'),
    recommend: modeState(uid, bgmId, 'recommend'),
  })
})

// BGM 资料（BYOK 前端要用；也可给「预览要发给 AI 的内容」用）
reviews.get('/:bgmId/material', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const bgmId = Number(c.req.param('bgmId'))
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  const track = trackStmt.get(uid, bgmId) as TrackRow | undefined
  if (!track) return c.json({ error: '未追这部番' }, 404)
  c.header('Cache-Control', 'no-store')
  return c.json({ material: await buildMaterial(bgmId, track) })
})

// 生成 4~6 个问题，写入草稿
reviews.post('/:bgmId/:mode/questions', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const loaded = loadTrack(uid, c.req.param('bgmId'), c.req.param('mode'))
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status)
  if (rateLimited(`ai-q:${uid}`, 20, 60 * 60 * 1000)) {
    return c.json({ error: '别催我……歇一会儿再写' }, 429)
  }
  const body = await readBody(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const opts = readWritingOpts(body, loaded.track)
  if ('error' in opts) return c.json({ error: opts.error }, 400)
  opts.mode = loaded.mode
  const material = await buildMaterial(loaded.bgmId, loaded.track)
  readMaterialExtras(material, body)

  let questions: DraftQuestion[]
  try {
    questions = await generateQuestions(material, opts)
  } catch (err) {
    if (err instanceof MaterialTooLargeError) return c.json({ error: err.message }, 413)
    const msg = err instanceof Error ? err.message : 'AI 生成失败'
    return c.json({ error: msg }, 502)
  }

  const now = Date.now()
  const existing = draftStmt.get(uid, loaded.bgmId, loaded.mode) as DraftRow | undefined
  upsertDraftStmt.run({
    user_id: uid,
    bgm_id: loaded.bgmId,
    mode: loaded.mode,
    episode: opts.episode,
    spoiler: opts.spoiler,
    tone: opts.tone,
    length: opts.length,
    questions: JSON.stringify(questions),
    answers: JSON.stringify({ picks: {}, custom: {} }),
    body: existing?.body ?? '',
    updated_at: now,
  })
  return c.json({ questions, draft: draftJson(draftStmt.get(uid, loaded.bgmId, loaded.mode) as DraftRow) })
})

// 按回答生成初稿正文，写入草稿 body
reviews.post('/:bgmId/:mode/generate', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const loaded = loadTrack(uid, c.req.param('bgmId'), c.req.param('mode'))
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status)
  if (rateLimited(`ai-g:${uid}`, 30, 60 * 60 * 1000)) {
    return c.json({ error: '别催我……歇一会儿再写' }, 429)
  }
  const body = await readBody(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const opts = readWritingOpts(body, loaded.track)
  if ('error' in opts) return c.json({ error: opts.error }, 400)
  opts.mode = loaded.mode
  const material = await buildMaterial(loaded.bgmId, loaded.track)
  readMaterialExtras(material, body)

  const draft = draftStmt.get(uid, loaded.bgmId, loaded.mode) as DraftRow | undefined
  const questions = normalizeQuestions(draft?.questions)
  const answers = normalizeAnswers(draft?.answers, questions)
  // 选择题的「回答」= 用户勾选的选项原文拼起来；一题都没勾就当作跳过。
  const qa = questions
    .map((quest, i) => {
      const parts = [...(answers.picks[String(i)] ?? [])]
      const c = answers.custom[String(i)]?.trim()
      if (c) parts.push(c)
      return { question: quest.q, answer: parts.join('；') }
    })
    .filter((x) => x.answer)

  // SSE：逐段把正文推给前端（text/event-stream）。校验 / 限流已在上面过完，
  // 到这里才开流。流开始后出的错只能走流内 { t: 'error' } 事件，前端照样能提示 + 保留手写。
  const persist = (text: string): void => {
    upsertDraftStmt.run({
      user_id: uid,
      bgm_id: loaded.bgmId,
      mode: loaded.mode,
      episode: opts.episode,
      spoiler: opts.spoiler,
      tone: opts.tone,
      length: opts.length,
      questions: draft?.questions ?? '[]',
      answers: draft?.answers ?? '{}',
      body: text.slice(0, BODY_MAX),
      updated_at: Date.now(),
    })
  }

  return streamSSE(c, async (stream) => {
    let acc = ''
    try {
      // generateDraftStream 内部已做 idle 看门狗 + 自动重连（最多 5 次）；这里只透传通知
      const r = await generateDraftStream(material, opts, qa, async (n) => {
        if (n.t === 'delta') {
          acc += n.v
          await stream.writeSSE({ data: JSON.stringify({ t: 'delta', v: n.v }) })
        } else {
          // 重连中：告诉前端「网络抖了一下，正在续写」
          await stream.writeSSE({ data: JSON.stringify({ t: 'retry', attempt: n.attempt, reason: n.reason }) })
        }
      })
      const finalText = (r.text || acc).slice(0, BODY_MAX)
      persist(finalText)
      await stream.writeSSE({
        data: JSON.stringify({ t: 'done', body: finalText, truncated: r.truncated }),
      })
    } catch (err) {
      // 流中途已经写出的部分也存一下，别让用户白等
      if (acc.trim()) persist(acc.slice(0, BODY_MAX))
      const msg = err instanceof MaterialTooLargeError ? err.message : err instanceof Error ? err.message : 'AI 生成失败'
      await stream.writeSSE({ data: JSON.stringify({ t: 'error', message: msg, body: acc.slice(0, BODY_MAX) }) })
    }
  })
})

// 保存草稿（写作设置 / 答案 / 正文 / 用户替换的问题）—— 自动保存走这条
reviews.put('/:bgmId/:mode/draft', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const loaded = loadTrack(uid, c.req.param('bgmId'), c.req.param('mode'))
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status)
  const body = await readBody(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)

  const prev = draftStmt.get(uid, loaded.bgmId, loaded.mode) as DraftRow | undefined
  const opts = readWritingOpts(body, loaded.track)
  if ('error' in opts) return c.json({ error: opts.error }, 400)

  const questions = 'questions' in body ? normalizeQuestions(body.questions) : normalizeQuestions(prev?.questions)
  const answers = 'answers' in body
    ? normalizeAnswers(body.answers, questions)
    : normalizeAnswers(prev?.answers, questions)
  const nextBody = typeof body.body === 'string' ? body.body.slice(0, BODY_MAX) : (prev?.body ?? '')

  upsertDraftStmt.run({
    user_id: uid,
    bgm_id: loaded.bgmId,
    mode: loaded.mode,
    episode: opts.episode,
    spoiler: opts.spoiler,
    tone: opts.tone,
    length: opts.length,
    questions: JSON.stringify(questions),
    answers: JSON.stringify(answers),
    body: nextBody,
    updated_at: Date.now(),
  })
  return c.json({ draft: draftJson(draftStmt.get(uid, loaded.bgmId, loaded.mode) as DraftRow) })
})

// 发布：草稿正文 → 当前内容（published=1），清空整份草稿（含问题、答案）
reviews.post('/:bgmId/:mode/publish', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const loaded = loadTrack(uid, c.req.param('bgmId'), c.req.param('mode'))
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status)
  const body = await readBody(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)

  const draft = draftStmt.get(uid, loaded.bgmId, loaded.mode) as DraftRow | undefined
  const text = (typeof body.body === 'string' ? body.body : draft?.body ?? '').slice(0, BODY_MAX)
  if (!text.trim()) return c.json({ error: '正文空着呢，写点东西再发' }, 400)

  const opts = readWritingOpts(body, loaded.track)
  if ('error' in opts) return c.json({ error: opts.error }, 400)
  const scoreShown = Number(body.scoreShown)
  const tagsShown = Array.isArray(body.tagsShown)
    ? body.tagsShown.filter((x): x is string => typeof x === 'string').slice(0, TAGS_SHOWN_MAX)
    : []
  const now = Date.now()
  const prevContent = contentStmt.get(uid, loaded.bgmId, loaded.mode) as ContentRow | undefined

  const publish = db.transaction(() => {
    upsertContentStmt.run({
      user_id: uid,
      bgm_id: loaded.bgmId,
      mode: loaded.mode,
      body: text,
      episode: opts.episode,
      spoiler: opts.spoiler,
      tone: opts.tone,
      length: opts.length,
      score_shown: Number.isFinite(scoreShown) && scoreShown > 0 ? Math.min(10, scoreShown) : 0,
      tags_shown: JSON.stringify(tagsShown),
      published: 1,
      published_at: now,
      created_at: prevContent?.created_at || now,
      updated_at: now,
    })
    deleteDraftStmt.run(uid, loaded.bgmId, loaded.mode)
  })
  publish()
  return c.json({ ...modeState(uid, loaded.bgmId, loaded.mode) })
})

// 撤回：当前内容保留，published → 0，公开页立即隐藏
reviews.post('/:bgmId/:mode/retract', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const loaded = loadTrack(uid, c.req.param('bgmId'), c.req.param('mode'))
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status)
  const content = contentStmt.get(uid, loaded.bgmId, loaded.mode) as ContentRow | undefined
  if (!content) return c.json({ error: '还没发过，撤回什么呀' }, 404)
  setPublishedStmt.run(0, content.published_at, Date.now(), uid, loaded.bgmId, loaded.mode)
  return c.json({ ...modeState(uid, loaded.bgmId, loaded.mode) })
})

// 删除草稿或当前内容
reviews.delete('/:bgmId/:mode', async (c) => {
  const uid = await requireUid(c)
  if (!uid) return c.json({ error: '未登录' }, 401)
  const loaded = loadTrack(uid, c.req.param('bgmId'), c.req.param('mode'))
  if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status)
  const target = c.req.query('target') === 'content' ? 'content' : 'draft'
  if (target === 'content') deleteContentStmt.run(uid, loaded.bgmId, loaded.mode)
  else deleteDraftStmt.run(uid, loaded.bgmId, loaded.mode)
  return c.json({ ...modeState(uid, loaded.bgmId, loaded.mode) })
})

export default reviews
