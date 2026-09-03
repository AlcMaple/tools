// 自配 API（BYOK）—— 浏览器直连用户填写的 OpenAI 兼容 endpoint。
//
// 边界（对应 docs/ideas/017 第 6.2 节）：
//   - API key 只落**这台设备的**浏览器 localStorage：绝不写服务器数据库 / 日志，也不跨设备同步；
//     换设备要重新填，清除靠「清掉 key」按钮。刷新 / 重开浏览器不丢（否则每天都要重填，没法用）
//   - endpoint / model 随账号设置同步（走 auth.saveAiConfig）
//   - endpoint 不支持浏览器跨域时，抛出可读错误让上层提示「切回服务器 AI」

import { consumeSSE } from '../lib/sse'

const KEY_STORAGE = 'mt.byok.key'

export interface AiConfig {
  provider: 'server' | 'byok'
  endpoint: string
  model: string
}

export const DEFAULT_AI_CONFIG: AiConfig = { provider: 'server', endpoint: '', model: '' }

export function readByokKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export function writeByokKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key)
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    /* 隐私模式 / 存储被禁用：这台设备就存不住 key，用户仍可切回服务器 AI */
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// 与 server/ai.ts 的 CHAT_TIMEOUT_MS 对齐：非流式整段生成完才回，中文长正文别按 30s 掐。
const BYOK_TIMEOUT_MS = 90_000

interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

async function byokChat(
  cfg: AiConfig,
  key: string,
  messages: ChatMessage[],
  jsonObject: boolean,
  label: string,
): Promise<string> {
  const base = cfg.endpoint.replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
  const payload = JSON.stringify({
    model: cfg.model,
    messages,
    stream: false,
    ...(jsonObject ? { response_format: { type: 'json_object' } } : {}),
  })
  const send = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: payload,
      signal: AbortSignal.timeout(BYOK_TIMEOUT_MS),
    })

  const t0 = Date.now()
  console.info(`[byok] → ${label}  model=${cfg.model}  请求体=${(payload.length / 1024).toFixed(1)}KB`)

  let res: Response
  let attempt = 1
  try {
    res = await send()
  } catch (err) {
    // 「Failed to fetch」在浏览器里既可能是 CORS 被拦、也可能是代理抖动掐断连接，两者无法区分。
    // 传输层失败重试一次（与 server/ai.ts 的 chat() 对齐）：真 CORS 的话重试也会立刻再挂，
    // 抖动的话大概率这次就过。超时（AbortError）不重试——那是对端慢 / 挂死，再打一遍没用。
    const name = err instanceof Error ? err.name : ''
    if (name === 'AbortError' || name === 'TimeoutError') {
      console.error(`[byok] ✗ ${label}  ${Date.now() - t0}ms 后超时（未重试）`)
      throw new Error('你的 API 半天没回……换个接口，或者用我这边的')
    }
    console.warn(`[byok] ⚠ ${label}  ${Date.now() - t0}ms 传输中断，0.6s 后重发（第 2 / 2 次）  ${name || 'fetch failed'}`)
    await new Promise((r) => setTimeout(r, 600))
    attempt = 2
    try {
      res = await send()
    } catch {
      console.error(`[byok] ✗ ${label}  重发仍失败（共 2 次）`)
      throw new Error('这个接口地址浏览器连不上……用我这边的吧')
    }
  }

  const ms = Date.now() - t0
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    console.error(`[byok] ✗ ${label}  HTTP ${res.status}  ${ms}ms  第 ${attempt} 次  ${detail}`)
    if (res.status === 401 || res.status === 403) throw new Error('这个 key 不对，或者没权限')
    throw new Error(`你的 API 返回了 ${res.status}`)
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: ChatUsage }
  const content = data.choices?.[0]?.message?.content?.trim() ?? ''
  const u = data.usage
  const tokens = u ? `tokens ${u.prompt_tokens ?? '?'}+${u.completion_tokens ?? '?'}=${u.total_tokens ?? '?'}` : 'tokens 未知'
  if (!content) {
    console.error(`[byok] ✗ ${label}  返回空内容  ${ms}ms  第 ${attempt} 次  ${tokens}`)
    throw new Error('你的 API 什么都没返回')
  }
  console.info(`[byok] ✓ ${label}  ${ms}ms  第 ${attempt} 次  ${tokens}  正文 ${content.length} 字`)
  return content
}

interface OpenAiStreamChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
  usage?: ChatUsage
}

// 与 server/ai.ts 的同名常量对齐 —— 智能体对话窗口以后也复用。
const STREAM_IDLE_MS = 25_000
const STREAM_MAX_ATTEMPTS = 5
const STREAM_MAX_TOTAL_MS = 5 * 60_000
const STREAM_BACKOFF_MS = [600, 1200, 2000, 3000]

export type StreamNotice = { t: 'delta'; v: string } | { t: 'retry'; attempt: number; reason: string }

interface AttemptOutcome {
  text: string
  finished: boolean
  usage?: ChatUsage
  reason: string
}

class HardError extends Error {}

/** 单次流式请求（浏览器直连）：idle 看门狗 + 读到底 / 读到断。 */
async function byokOneAttempt(
  url: string,
  key: string,
  cfg: AiConfig,
  messages: ChatMessage[],
  onPiece: (piece: string) => void,
): Promise<AttemptOutcome> {
  const payload = JSON.stringify({ model: cfg.model, messages, stream: true, stream_options: { include_usage: true } })
  const ctrl = new AbortController()
  let idle: ReturnType<typeof setTimeout> | undefined
  const armIdle = (): void => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => ctrl.abort(new Error('idle-timeout')), STREAM_IDLE_MS)
  }
  armIdle()

  let text = ''
  let finished = false
  let usage: ChatUsage | undefined
  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: payload,
        signal: ctrl.signal,
      })
    } catch (err) {
      // 浏览器里 CORS 被拦也是 TypeError，无法与抖动区分 —— 交给外层按次数兜底
      return { text, finished, reason: `连接失败 ${err instanceof Error ? err.name : ''}` }
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      if (res.status === 401 || res.status === 403) throw new HardError('这个 key 不对，或者没权限')
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new HardError(`你的 API 返回了 ${res.status}`)
      return { text, finished, reason: `HTTP ${res.status} ${detail}` }
    }
    if (!res.body) return { text, finished, reason: '空响应体' }

    await consumeSSE<OpenAiStreamChunk>(res.body, (j) => {
      const piece = j.choices?.[0]?.delta?.content
      if (piece) {
        text += piece
        onPiece(piece)
        armIdle()
      }
      if (j.choices?.[0]?.finish_reason) finished = true
      if (j.usage) usage = j.usage
    })
    return { text, finished, usage, reason: finished ? '' : '连接提前结束' }
  } catch (err) {
    if (err instanceof HardError) throw err
    const isIdle = ctrl.signal.aborted || (err instanceof Error && err.message === 'idle-timeout')
    return { text, finished, usage, reason: isIdle ? `${STREAM_IDLE_MS / 1000}s 没有新内容` : '流中断' }
  } finally {
    if (idle) clearTimeout(idle)
  }
}

/**
 * 浏览器直连、带韧性的流式调用。逐段（含重连通知）经 onNotice 回来。
 * idle 看门狗 + 自动重连（续写），策略与 server/ai.ts chatStream 一致。
 */
async function byokChatStream(
  cfg: AiConfig,
  key: string,
  messages: ChatMessage[],
  label: string,
  onNotice: (n: StreamNotice) => void,
): Promise<{ text: string; truncated: boolean }> {
  const base = cfg.endpoint.replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
  const t0 = Date.now()
  console.info(`[byok] → ${label} (stream)  model=${cfg.model}  最多重连 ${STREAM_MAX_ATTEMPTS} 次`)

  let acc = ''
  let usage: ChatUsage | undefined
  let lastReason = ''

  for (let attempt = 1; attempt <= STREAM_MAX_ATTEMPTS; attempt++) {
    if (Date.now() - t0 > STREAM_MAX_TOTAL_MS) {
      lastReason = `总时长超过 ${STREAM_MAX_TOTAL_MS / 1000}s`
      break
    }
    const lastBreak = Math.max(acc.lastIndexOf('。'), acc.lastIndexOf('！'), acc.lastIndexOf('？'), acc.lastIndexOf('\n'))
    const tail = lastBreak >= 0 ? acc.slice(lastBreak + 1) : acc
    const msgs: ChatMessage[] = acc
      ? [
          ...messages,
          { role: 'assistant', content: acc },
          {
            role: 'user',
            content:
              tail.trim().length > 0
                ? `上面这段在「${tail}」这里被网络截断了。请从这半句开始，先把它补写完整、再自然地写到结尾。只输出「${tail}」之后的内容，不要重复前面已完整的句子，不要加开场白。`
                : '接着上面的正文写到结尾，只输出后面的部分，不要重复已有内容，不要加开场白。',
          },
        ]
      : messages

    const isContinuation = attempt > 1 && acc.length > 0
    let dedupBuf = ''
    let dedupDone = !isContinuation
    const flushDedup = (): void => {
      let overlap = 0
      for (let k = Math.min(50, acc.length, dedupBuf.length); k > 0; k--) {
        if (acc.endsWith(dedupBuf.slice(0, k))) {
          overlap = k
          break
        }
      }
      const rest = dedupBuf.slice(overlap)
      if (rest) {
        acc += rest
        onNotice({ t: 'delta', v: rest })
      }
    }
    const emit = (piece: string): void => {
      if (dedupDone) {
        acc += piece
        onNotice({ t: 'delta', v: piece })
        return
      }
      dedupBuf += piece
      if (dedupBuf.length < 60) return
      dedupDone = true
      flushDedup()
    }

    let outcome: AttemptOutcome
    try {
      outcome = await byokOneAttempt(url, key, cfg, msgs, emit)
    } catch (err) {
      if (err instanceof HardError) {
        console.error(`[byok] ✗ ${label} (stream)  ${err.message}`)
        throw new Error(err.message)
      }
      throw err
    }
    if (!dedupDone && dedupBuf) flushDedup()
    if (outcome.usage) usage = outcome.usage

    if (outcome.finished) {
      const ms = Date.now() - t0
      const tk = usage
        ? `tokens ${usage.prompt_tokens ?? '?'}+${usage.completion_tokens ?? '?'}=${usage.total_tokens ?? '?'}`
        : 'tokens 未知'
      console.info(`[byok] ✓ ${label} (stream)  ${ms}ms  ${attempt} 次连接  ${tk}  正文 ${acc.length} 字`)
      return { text: acc, truncated: false }
    }

    lastReason = outcome.reason || '未知中断'
    console.warn(`[byok] ⚠ ${label} (stream)  第 ${attempt}/${STREAM_MAX_ATTEMPTS} 次断于 ${acc.length} 字：${lastReason}`)
    if (attempt < STREAM_MAX_ATTEMPTS) {
      onNotice({ t: 'retry', attempt: attempt + 1, reason: lastReason })
      await new Promise((r) => setTimeout(r, STREAM_BACKOFF_MS[Math.min(attempt - 1, STREAM_BACKOFF_MS.length - 1)]))
    }
  }

  if (acc) {
    console.warn(`[byok] ⚠ ${label} (stream)  重连用尽仍未写完，返回已有 ${acc.length} 字  ${lastReason}`)
    return { text: acc, truncated: true }
  }
  console.error(`[byok] ✗ ${label} (stream)  重连 ${STREAM_MAX_ATTEMPTS} 次全失败  ${lastReason}`)
  throw new Error('你的 API 连不上……换个接口，或者用我这边的')
}

const MODE_LABEL = { review: '观后点评', recommend: '推荐文' } as const

export interface ByokSettings {
  tone: string
  length: string
  spoiler: string
  episode: number
  status: 'watching' | 'done'
}

// 篇幅字数区间——与 server/ai.ts、src/reviews/reviewsApi.ts 的同名表保持一致（各自独立维护）。
const LENGTH_WORDS: Record<string, string> = {
  简短: '80~150 字',
  中等: '200~350 字',
  详细: '450~600 字',
}
function lengthInstruction(length: string): string {
  return `正文字数控制在 ${LENGTH_WORDS[length] || LENGTH_WORDS['中等']} 左右，不要明显超出或不足。`
}

/**
 * 剧透范围指令——与 server/ai.ts 的 spoilerInstruction 同一套语义：「已播出可剧透」的边界是
 * 用户自己确认的观看进度（这部作品/这一季内），不是这部番客观播出到第几集。
 */
function spoilerInstruction(settings: ByokSettings): string {
  if (settings.spoiler === 'none') return '无剧透：完全不涉及具体剧情，只从感受、氛围、观感角度写。'
  if (settings.spoiler === 'all') {
    return '全剧透：可以剧透原作全部内容，包括这部作品目前还没动画化的后续剧情。'
  }
  if (settings.status === 'done') {
    return '已播剧透：可以剧透这部作品已播出的全部剧情，但不要涉及尚未播出的后续季、也不要涉及原作未改编的内容。'
  }
  const safeThrough = settings.episode - 1
  if (safeThrough < 1) {
    return '已播剧透：用户连第 1 集都还没看完，暂时没有可剧透的剧情，请完全不要剧透。'
  }
  return `已播剧透：只能剧透到这部作品第 ${safeThrough} 集为止（含）；第 ${settings.episode} 集及之后的剧情、结局、后续走向一律不能提及。`
}

function systemPrompt(mode: 'review' | 'recommend', settings: ByokSettings): string {
  return [
    `你在帮用户写一部动画的「${MODE_LABEL[mode]}」，一段面向所有读者的正文，不设收件人、不写私聊口吻。`,
    mode === 'review'
      ? '这是「观后点评」：写用户自己看完之后的感受、印象和触动，重点是「我看下来是什么体验」，不是「你要不要看」。' +
        '不要写成面向路人的安利，不要出现「推荐给…」「不妨一试」「值得一看」「喜欢 X 的不要错过」这类导向句。'
      : '这是「推荐文」：语气跟「观后点评」完全一样——第一人称、大白话、像跟一个还没看的朋友聊天，说你自己看下来什么感觉。区别只在落点：让对方能判断要不要看。' +
        '写成 Bangumi 上那种推荐短评的样子：话不多，几句说完；开头就给个明确态度（「值得一看」「没那么神但挺顶」「强推，但有门槛」之类），' +
        '然后好和不好都点到——落到具体的东西：剧情结构、某个伏笔、节奏、人物对话、某场戏、某个角色。' +
        '少用「叙事张力」「人性剖析」「封神」这种又虚又用力的词；别堆辞藻，别写「XX 的作画尤其放得开」这种影评人腔、公司介绍腔，别用「嗓子都在燃烧」这种使劲的比喻，也别教人怎么看。' +
        '点名可以（篇章名、动画公司、声优），但像随口一提。缺点该说就说，推荐 ≠ 只夸。',
    `语气：${settings.tone || '自然'}。${lengthInstruction(settings.length)}`,
    spoilerInstruction(settings),
    '内容要符合这部作品的真实情况——可以用你对这部番的了解，别编造你自己也不确定的东西。用简体中文输出。',
  ].join('\n')
}

export interface ByokMaterialText {
  material: string
  confirmed: string
}

// 与 server/ai.ts 的 ReviewQuestion 同形
export interface ByokQuestion {
  q: string
  options: string[]
  multi: boolean
}

function normalizeQuestions(list: unknown): ByokQuestion[] {
  if (!Array.isArray(list)) return []
  const out: ByokQuestion[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const q = typeof item.q === 'string' ? item.q.trim() : ''
    const options = Array.isArray(item.options)
      ? item.options.map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean).slice(0, 6)
      : []
    if (!q || options.length < 2) continue
    out.push({ q: q.slice(0, 200), options: options.map((o) => o.slice(0, 120)), multi: item.multi === true })
    if (out.length >= 6) break
  }
  return out
}

export async function byokQuestions(
  cfg: AiConfig,
  key: string,
  mode: 'review' | 'recommend',
  settings: ByokSettings,
  m: ByokMaterialText,
): Promise<ByokQuestion[]> {
  const raw = await byokChat(
    cfg,
    key,
    [
      { role: 'system', content: systemPrompt(mode, settings) },
      {
        role: 'user',
        content: [
          `请基于以下资料，设计 4 到 6 道帮用户表达想法的选择题，供后面写「${MODE_LABEL[mode]}」用（给「不擅长写、说不上来」的人用）：`,
          mode === 'review'
            ? '- 这是「观后点评」的问题：问用户自己看下来的体验——最打动 / 触动他的地方、哪里让他意外或出戏、有没有失望、印象最深的一场戏、看完的心情。不要出「你会推荐给谁」「适不适合新人」这种面向路人的问题'
            : '- 这是「推荐文」的问题，落点仍是用户自己的体验，只是朝「怎么跟没看的人讲」的方向问：他最想让别人也体验到的是什么、这番他会特地拿出来讲的一个点（某段剧情 / 某个角色 / 某处作画 / 演出 / 声优都行）、他会怎么一句话跟朋友形容这番、有没有他觉得得先提醒一句的（节奏、致郁、吵、需补前作等）、他觉得什么样的人会喜欢。提醒 / 缺点也要出选项，别全是彩虹屁；不要问「适合在什么状态 / 什么时候看」这种和推荐无关的问题',
          '- 每道题给 4~6 个写好的候选答案，像真实的二次元观众发弹幕 / 写短评那样说',
          '- **每个选项连标点算在内不超过 32 字**（能说清楚就行，不必强行压短）；不要「是/否」「喜欢/一般」这种干巴巴的词',
          '- 语气自然口语，可以用「贴贴」「真百合 / 轻百合」「发糖」「HE / BE」「意难平」「上头」「下饭」「名场面」「刀了」「破防」这类圈内说法，但别硬凹梗、别用「我嗑死了」「奥利给」这种烂梗，也别浮夸卖萌',
          '- 选项要贴合这部番的真实内容（用你对这部作品的了解），不要凭空编造剧情、人物、桥段',
          '- 「用户的好看集备注」只借他的语气和关注点。如果他把人物关系 / 性别记错了，你按正确的写就行，但**不要在选项里特意纠正、也不要加「（其实是男的）」这类括号说明**',
          '- 可以多选的题标 "multi": true，只能单选的标 "multi": false',
          settings.spoiler !== 'all' ? '- 题目和选项不要剧透超出允许范围' : '',
          '只返回 JSON：{"questions":[{"q":"...","options":["...","..."],"multi":true}]}。',
          '',
          '【番剧资料】',
          m.material,
          '',
          '【用户确认的内容】',
          m.confirmed,
        ].filter(Boolean).join('\n'),
      },
    ],
    true,
    `questions ${MODE_LABEL[mode]}`,
  )
  let parsed: { questions?: unknown }
  try {
    parsed = JSON.parse(raw) as { questions?: unknown }
  } catch {
    throw new Error('返回的东西乱了……重新生成一下')
  }
  const questions = normalizeQuestions(parsed.questions)
  if (questions.length < 4) throw new Error('问题没凑齐……再来一次')
  return questions
}

function draftMessages(
  mode: 'review' | 'recommend',
  settings: ByokSettings,
  m: ByokMaterialText,
  qa: { question: string; answer: string }[],
): ChatMessage[] {
  const answered = qa.filter((x) => x.answer.trim())
  const qaText = answered.length
    ? answered.map((x, i) => `${i + 1}. 关于「${x.question}」，他的倾向：${x.answer}`).join('\n')
    : '（用户没有勾选，写作时仅依据资料和写作设置，写一段克制、不臆造的初稿）'
  return [
    { role: 'system', content: systemPrompt(mode, settings) },
    {
      role: 'user',
      content: [
        `请写一段可直接发布的「${MODE_LABEL[mode]}」正文，直接输出正文，不要标题和开场白。`,
        '下面「用户的想法」是他从几道选择题里勾的选项，代表他的看法和倾向——不是让你照抄、也不是把这些句子逐条串起来。',
        '理解他想表达的意思，用你自己的话、连贯自然地写成一段，像他本人认真写出来的：观点是他的，句子是重新组织的。别跑偏成另一个人的观感。',
        settings.spoiler !== 'all' ? '正文里的剧情只能停在系统消息里「剧透范围」允许的边界内。' : '',
        '',
        '【番剧资料】',
        m.material,
        '',
        '【用户确认的内容】',
        m.confirmed,
        '',
        '【用户的想法（选择题里勾的）】',
        qaText,
      ].join('\n'),
    },
  ]
}

/** 流式生成初稿：正文一段段（含重连通知）经 onNotice 回来，返回最终全文 + 是否中途断过。 */
export async function byokDraftStream(
  cfg: AiConfig,
  key: string,
  mode: 'review' | 'recommend',
  settings: ByokSettings,
  m: ByokMaterialText,
  qa: { question: string; answer: string }[],
  onNotice: (n: StreamNotice) => void,
): Promise<{ text: string; truncated: boolean }> {
  return byokChatStream(cfg, key, draftMessages(mode, settings, m, qa), `draft ${MODE_LABEL[mode]}`, onNotice)
}

export function materialToText(m: {
  title: string
  titleCn: string
  eps: number
  score: number
  tags: string[]
  staff: string[]
  summary: string
  platform: string
  goodEpisodeNotes?: string[]
}): string {
  const lines = [
    `原名：${m.title || '（无）'}`,
    `中文名：${m.titleCn || '（无）'}`,
    `平台：${m.platform || '（未知）'}`,
    `话数：${m.eps > 0 ? m.eps : '（未定 / 连载中）'}`,
    `BGM 评分：${m.score > 0 ? m.score : '（暂无）'}`,
    `BGM 标签：${m.tags.length ? m.tags.join('、') : '（无）'}`,
    `制作信息：${m.staff.length ? m.staff.join('；') : '（无）'}`,
    `简介：${m.summary || '（无）'}`,
  ]
  if (m.goodEpisodeNotes && m.goodEpisodeNotes.length) {
    lines.push('用户在「好看集」里随手写的备注（只言片语，不是完整点评，只帮你把握他的用词语气；他可能记错或很主观，别把里面的错当真）：\n' + m.goodEpisodeNotes.join('\n'))
  }
  return lines.join('\n')
}
