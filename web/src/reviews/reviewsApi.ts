// 推荐与点评助手的前端接口封装 —— 对齐 src/api.ts 风格，类型独立声明。
// 服务端合同见 web/server/reviews.ts。
import { consumeSSE } from '../lib/sse'

export type ReviewMode = 'review' | 'recommend'
export type Spoiler = 'none' | 'aired' | 'all'

export const MODE_LABEL: Record<ReviewMode, string> = { review: '观后点评', recommend: '推荐文' }
export const SPOILER_LABEL: Record<Spoiler, string> = {
  none: '无剧透',
  // 「已播出」原文案会让人以为是「这部番播出了多少集」，实际边界是发帖人自己看到的进度——
  // 在追时只到「看到第 N 集」的 N-1 集为止，看完则是这部作品全部内容，不含后续季。
  aired: '看过的可剧透',
  all: '全剧透',
}

// 篇幅字数区间 —— 直接写进给 AI 的 prompt，不能让模型自己拿捏「中等」是多长。
// UI 展示同一份数字（不重复定义两套），server/ai.ts 和 src/reviews/byok.ts 各自复制一份同步维护
// （网页前端不共享后端代码，见 src/api.ts 头部同类注释）。
export const LENGTH_WORDS: Record<string, string> = {
  // 参考 B 站短评上限 100 字、Bangumi 长评主流 200~400 字：点评本来就该短，写太长没人看完。
  简短: '80~150 字',
  中等: '200~350 字',
  详细: '450~600 字',
}

// 语气选项在下拉/分段按钮上只放得下两三个字，完整语感另外用一行说明展示，不塞进选项文字里。
export const TONE_HINT: Record<string, string> = {
  真诚: '像认真跟朋友聊感受',
  克制: '不煽情，冷静客观',
  热情: '语气热络，像用心安利',
  幽默: '带点调侃和玩梗',
  毒舌: '缺点也直说，犀利吐槽',
}

// 问题一律做成选择题（单选 / 多选 + 预制答案）——写点评的门槛就是「不知道怎么说」，
// 让用户填空等于没解决问题。最后统一给一个「其他补充」自由框兜底。
export interface ReviewQuestion {
  q: string
  options: string[]
  multi: boolean
}
export interface ReviewAnswers {
  /** 题号（"0".."5"）→ 选中的选项原文 */
  picks: Record<string, string[]>
  /** 题号 → 用户在这道题下手打的补充（预制选项不够用时） */
  custom: Record<string, string>
}

export const EMPTY_ANSWERS: ReviewAnswers = { picks: {}, custom: {} }

export interface ReviewDraft {
  episode: number
  spoiler: Spoiler
  tone: string
  length: string
  questions: ReviewQuestion[]
  answers: ReviewAnswers
  body: string
  updatedAt: number
}

export interface ReviewContent {
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
}

export interface ModeState {
  draft: ReviewDraft | null
  content: ReviewContent | null
}

export interface ReviewsState {
  track: { status: string; episode: number; totalEpisodes: number | null } | null
  review: ModeState
  recommend: ModeState
}

export interface Material {
  bgmId: number
  title: string
  titleCn: string
  type: string
  platform: string
  eps: number
  summary: string
  tags: string[]
  score: number
  staff: string[]
  /** 用户在这部番的好看集里写的备注——给 AI 把握用词语气用 */
  goodEpisodeNotes?: string[]
}

export interface WritingSettings {
  episode: number
  spoiler: Spoiler
  tone: string
  length: string
}

export interface MaterialExtras {
  userScore?: number
  userTags?: string[]
  episodeNote?: string
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

const jsonHeaders = { 'Content-Type': 'application/json' }

export async function fetchReviewsState(bgmId: number): Promise<ReviewsState> {
  return json<ReviewsState>(await fetch(`/api/reviews/${bgmId}`, { cache: 'no-store' }))
}

export async function fetchMaterial(bgmId: number): Promise<Material> {
  const { material } = await json<{ material: Material }>(
    await fetch(`/api/reviews/${bgmId}/material`, { cache: 'no-store' }),
  )
  return material
}

export async function generateQuestions(
  bgmId: number,
  mode: ReviewMode,
  settings: WritingSettings,
  extras: MaterialExtras = {},
): Promise<{ questions: ReviewQuestion[]; draft: ReviewDraft }> {
  return json(
    await fetch(`/api/reviews/${bgmId}/${mode}/questions`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ...settings, ...extras }),
    }),
  )
}

interface DraftStreamEvent {
  t: 'delta' | 'retry' | 'done' | 'error'
  v?: string
  body?: string
  truncated?: boolean
  message?: string
  attempt?: number
  reason?: string
}

export interface DraftStreamHandlers {
  onDelta: (piece: string) => void
  /** 服务端 idle 看门狗触发 / 连接断了，正在自动续写（attempt 是第几次连接，最多 5） */
  onRetry?: (attempt: number, reason: string) => void
}

/**
 * 流式生成初稿：正文一段段经 onDelta 回来。返回最终全文 + 是否中途断过。
 * 服务端已做 idle 看门狗 + 自动重连（最多 5 次），重连时 onRetry 会被调用。
 * 5 次连接都失败才 throw。
 */
export async function generateDraftStream(
  bgmId: number,
  mode: ReviewMode,
  settings: WritingSettings,
  handlers: DraftStreamHandlers,
  extras: MaterialExtras = {},
): Promise<{ body: string; truncated: boolean }> {
  const res = await fetch(`/api/reviews/${bgmId}/${mode}/generate`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ ...settings, ...extras }),
  })
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(b.error || `HTTP ${res.status}`)
  }
  if (!res.body) throw new Error('没收到回应……再试一次')

  let body = ''
  let truncated = false
  let streamErr: Error | null = null
  await consumeSSE<DraftStreamEvent>(res.body, (evt) => {
    if (evt.t === 'delta' && evt.v) {
      body += evt.v
      handlers.onDelta(evt.v)
    } else if (evt.t === 'retry') {
      handlers.onRetry?.(evt.attempt ?? 0, evt.reason ?? '')
    } else if (evt.t === 'done') {
      body = evt.body ?? body
      truncated = !!evt.truncated
    } else if (evt.t === 'error') {
      if (evt.body) body = evt.body
      streamErr = new Error(evt.message || 'AI 生成失败')
    }
  })
  if (streamErr) throw streamErr
  return { body, truncated }
}

export interface DraftPatch extends Partial<WritingSettings> {
  questions?: ReviewQuestion[]
  answers?: ReviewAnswers
  body?: string
}

export async function saveDraft(bgmId: number, mode: ReviewMode, patch: DraftPatch): Promise<{ draft: ReviewDraft }> {
  return json(
    await fetch(`/api/reviews/${bgmId}/${mode}/draft`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(patch),
    }),
  )
}

export interface PublishPayload extends WritingSettings {
  body: string
  scoreShown?: number
  tagsShown?: string[]
}

export async function publishReview(bgmId: number, mode: ReviewMode, payload: PublishPayload): Promise<ModeState> {
  return json<ModeState>(
    await fetch(`/api/reviews/${bgmId}/${mode}/publish`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),
  )
}

export async function retractReview(bgmId: number, mode: ReviewMode): Promise<ModeState> {
  return json<ModeState>(await fetch(`/api/reviews/${bgmId}/${mode}/retract`, { method: 'POST' }))
}

export async function deleteReview(
  bgmId: number,
  mode: ReviewMode,
  target: 'draft' | 'content',
): Promise<ModeState> {
  return json<ModeState>(
    await fetch(`/api/reviews/${bgmId}/${mode}?target=${target}`, { method: 'DELETE' }),
  )
}
