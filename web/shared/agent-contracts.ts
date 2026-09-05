// 阶段 0 的可执行合同；没有工具实现、路由注册或数据库副作用。
export const AGENT_CONTRACT_VERSION = 1
export const TRACK_STATUSES = ['watching', 'plan', 'considering', 'done'] as const
export const CONTEXT_TIERS = { '64k': 64_000, '128k': 128_000, '256k': 256_000, '1m': 1_000_000 } as const
export type ContextTier = keyof typeof CONTEXT_TIERS
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

// 只使用以下 JSON Schema 子集；provider 适配器须保留这些约束，服务端再独立校验。
export interface ContractSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null'
  enum?: readonly (string | number | boolean | null)[]
  anyOf?: readonly ContractSchema[]
  properties?: Readonly<Record<string, ContractSchema>>
  required?: readonly string[]
  additionalProperties?: false
  minProperties?: number
  items?: ContractSchema
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  maximum?: number
}

const text = (maxLength: number, minLength = 1): ContractSchema => ({ type: 'string', minLength, maxLength })
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): ContractSchema => ({ type: 'integer', minimum, maximum })
const choice = (...values: string[]): ContractSchema => ({ type: 'string', enum: values })
const object = (properties: Record<string, ContractSchema>, required = Object.keys(properties), minProperties = 0): ContractSchema =>
  ({ type: 'object', properties, required, additionalProperties: false, minProperties })
const array = (items: ContractSchema, maxItems = 30, minItems = 0): ContractSchema => ({ type: 'array', items, maxItems, minItems })
const nullable = (schema: ContractSchema): ContractSchema => ({ anyOf: [schema, { type: 'null' }] })
const boolean: ContractSchema = { type: 'boolean' }
const bgmId = integer(1)
const trackId: ContractSchema = { anyOf: [bgmId, integer(-Number.MAX_SAFE_INTEGER, -1)] }
const id: ContractSchema = { ...text(100), pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$' }
const limit = integer(1, 30)
const tags: ContractSchema = { ...array(text(20), 12), uniqueItems: true }
const status = choice(...TRACK_STATUSES)

export const SOURCE_SCHEMA = object({
  sourceId: id,
  kind: choice('offline_index', 'current_page', 'calendar_cache', 'my_tracks', 'public_reviews', 'public_aggregate'),
  label: text(120), bgmId: trackId, retrievedAt: integer(), cachedAt: nullable(integer()),
}, ['sourceId', 'kind', 'label', 'retrievedAt'])

const anime = object({
  bgmId, title: text(200), titleCn: text(200, 0), year: nullable(integer(1900, 2200)),
  episodes: nullable(integer(1, 20_000)), tags, completed: nullable(boolean),
}, ['bgmId', 'title', 'titleCn', 'year', 'episodes', 'tags', 'completed'])
const track = object({ bgmId: trackId, title: text(200), status, episode: integer(0, 20_000), userTags: tags })
const trackFields = object({ status, episode: integer(0, 20_000), userTags: tags }, [], 1)
const review = object({
  reviewId: id, bgmId, mode: choice('review', 'recommend'), body: text(4000),
  spoiler: choice('none', 'aired', 'all'), author: text(100), publishedAt: integer(),
})
const metric = choice('public_users', 'public_tracks', 'public_reviews', 'public_recommendations')

export const WEB_VIEW_SCHEMA: ContractSchema = { anyOf: [
  object({ view: choice('search'), params: object({ query: text(120, 0) }) }),
  object({ view: choice('anime', 'load_anime', 'review_assistant'), params: object({ bgmId }) }),
  object({ view: choice('calendar', 'refresh_calendar', 'tracks', 'community'), params: object({}) }),
  object({ view: choice('source_search'), params: object({ bgmId, source: choice('xifan', 'girigiri') }) }),
] }

const previewBase = { actionId: id, bgmId: trackId, expiresAt: integer(), impact: text(600) }
const trackPreview = object({
  ...previewBase, kind: choice('track_change'), expectedRevision: integer(),
  before: nullable(track), after: track,
})
const playbackPreview = object({
  ...previewBase, bgmId, kind: choice('playback_open'), title: text(200),
  source: choice('xifan', 'girigiri'), episode: integer(1, 20_000), target: choice('web_player'),
})

interface ToolContract {
  description: string
  mode: 'read' | 'navigation_intent' | 'proposal'
  scope: 'public' | 'current_user' | 'current_page'
  parameters: ContractSchema
  result: ContractSchema
  timeoutMs: number
  maxCallsPerTurn: number
}

export const AGENT_TOOLS = {
  searchOfflineAnime: {
    description: '只查离线 BGM 索引和本地补充条目；空结果不在线回退。', mode: 'read', scope: 'public',
    parameters: object({ filters: object({
      query: text(120), similarToBgmId: bgmId, tags, yearFrom: integer(1900, 2200), yearTo: integer(1900, 2200),
      completed: boolean, episodesMax: integer(1, 20_000), limit,
    }, ['limit']) }),
    result: object({ items: array(anime) }), timeoutMs: 3000, maxCallsPerTurn: 12,
  },
  readCurrentAnimeContext: {
    description: '只读当前会话经确认带入的页面资料；缺失时返回 CONTEXT_MISSING。', mode: 'read', scope: 'current_page',
    parameters: object({}), result: object({ anime, summary: text(12_000, 0), loadedAt: integer() }),
    timeoutMs: 1000, maxCallsPerTurn: 12,
  },
  readCachedCalendar: {
    description: '只读已有周历缓存及时间；过期照实标注，缺失返回 CACHE_MISS。', mode: 'read', scope: 'public',
    parameters: object({ range: object({ weekdays: { ...array(integer(1, 7), 7, 1), uniqueItems: true }, limit }, ['limit']) }),
    result: object({ items: array(object({ weekday: integer(1, 7), anime })), cachedAt: integer(), stale: boolean }),
    timeoutMs: 1000, maxCallsPerTurn: 12,
  },
  listMyTracks: {
    description: '只查登录账号的追番字段及账号级 revision；不触发元数据补全。', mode: 'read', scope: 'current_user',
    parameters: object({ filters: object({ status, tags, bgmIds: { ...array(trackId), uniqueItems: true }, limit, offset: integer(0, 5000) }, ['limit']) }),
    result: object({ items: array(track), revision: integer() }), timeoutMs: 3000, maxCallsPerTurn: 12,
  },
  listPublicReviews: {
    description: '只查作者开启公开追番且已发布的点评/推荐；按剧透范围筛选。', mode: 'read', scope: 'public',
    parameters: object({ bgmId, filters: object({ mode: choice('review', 'recommend'), spoiler: choice('none', 'aired', 'all'), limit }, ['spoiler', 'limit']) }),
    result: object({ items: array(review) }), timeoutMs: 3000, maxCallsPerTurn: 12,
  },
  aggregatePublicData: {
    description: '只读预定义的公开用户/追番/点评/推荐数量；不接受 SQL、URL 或页面脚本。', mode: 'read', scope: 'public',
    parameters: object({ metric, filters: object({ bgmId, status }, []) }),
    result: object({ metric, value: integer(), asOf: integer() }), timeoutMs: 3000, maxCallsPerTurn: 12,
  },
  openWebView: {
    description: '仅生成白名单网页按钮意图；用户点击前不跳转、不刷新、不解析、不播放。', mode: 'navigation_intent', scope: 'current_user',
    parameters: WEB_VIEW_SCHEMA, result: WEB_VIEW_SCHEMA, timeoutMs: 1000, maxCallsPerTurn: 12,
  },
  proposeTrackChange: {
    description: '只生成追番添加/状态/进度/标签预览；旧值和 revision 由服务端读取。', mode: 'proposal', scope: 'current_user',
    parameters: { anyOf: [
      object({ bgmId, change: object({ kind: choice('add'), fields: trackFields }) }),
      object({ bgmId: trackId, change: object({ kind: choice('update'), fields: trackFields }) }),
    ] },
    result: trackPreview, timeoutMs: 3000, maxCallsPerTurn: 12,
  },
  proposePlaybackOpen: {
    description: '只生成稀饭/Girigiri 的番剧、集数和目标页面预览；不请求源站。', mode: 'proposal', scope: 'current_user',
    parameters: object({ bgmId, source: choice('xifan', 'girigiri'), episode: integer(1, 20_000) }),
    result: playbackPreview, timeoutMs: 1000, maxCallsPerTurn: 12,
  },
} as const satisfies Record<string, ToolContract>

export type AgentToolName = keyof typeof AGENT_TOOLS
export const TOOL_NAMES = Object.freeze(Object.keys(AGENT_TOOLS) as AgentToolName[])
export const TOOL_CALL_SCHEMA: ContractSchema = { anyOf: TOOL_NAMES.map(name => object({ name: choice(name), arguments: AGENT_TOOLS[name].parameters })) }
export const MODEL_OUTPUT_SCHEMA: ContractSchema = { anyOf: [
  object({ kind: choice('answer'), text: text(16_000), sourceIds: { ...array(id), uniqueItems: true } }),
  object({ kind: choice('tool_calls'), calls: array(TOOL_CALL_SCHEMA, 4, 1) }),
] }

// 仅用户确认接口消费；不加入 TOOL_NAMES，也不发送给模型。
export const APPLY_TRACK_CHANGE_SCHEMA = object({
  actionId: id, requestId: id, expectedRevision: integer(), confirmationToken: text(512, 32),
})

export const ERROR_CODES = [
  'INVALID_ARGUMENT', 'UNREGISTERED_TOOL', 'AUTH_REQUIRED', 'NOT_FOUND', 'CONTEXT_MISSING', 'CACHE_MISS',
  'REVISION_CONFLICT', 'CONFIRMATION_REQUIRED', 'ACTION_EXPIRED', 'RATE_LIMITED', 'QUOTA_EXCEEDED',
  'PROVIDER_UNAVAILABLE', 'PROVIDER_CAPABILITY', 'INVALID_OUTPUT', 'TIMEOUT', 'CANCELLED', 'INTERNAL_ERROR',
] as const
export type AgentErrorCode = typeof ERROR_CODES[number]
export const TOOL_ERROR_SCHEMA = object({ ok: { type: 'boolean', enum: [false] }, code: choice(...ERROR_CODES), message: text(300), retryable: boolean })
export const toolResultSchema = (name: AgentToolName): ContractSchema => ({ anyOf: [
  object({ ok: { type: 'boolean', enum: [true] }, data: AGENT_TOOLS[name].result, sources: array(SOURCE_SCHEMA), resultCount: integer(0, 30), truncated: boolean }),
  TOOL_ERROR_SCHEMA,
] })

export const ACTION_STATES = [
  'prepared', 'user_confirmed', 'dispatch_started', 'navigation_committed', 'player_ready', 'source_selected',
  'media_canplay', 'playing', 'completed', 'failed', 'cancelled', 'unknown',
] as const
export type ActionState = typeof ACTION_STATES[number]
const anchoredFact = object({
  value: text(1200, 0), messageIds: array(id, 50, 1), sourceIds: array(id, 50),
  certainty: choice('confirmed', 'readback', 'observed', 'unknown'),
})
export const SUMMARY_STATE_SCHEMA = object({
  task_goal: anchoredFact, confirmed_preferences: { ...array(id, 50), uniqueItems: true },
  entities: array(object({ bgmId: trackId, title: text(200), messageIds: array(id, 50, 1) }), 50),
  constraints: array(anchoredFact, 50), decisions: array(anchoredFact, 50), source_refs: { ...array(id, 200), uniqueItems: true },
  tool_results: array(object({ tool: choice(...TOOL_NAMES), sourceId: id, hash: { ...text(64, 64), pattern: '^[a-f0-9]{64}$' }, summary: text(600) }), 100),
  action_receipts: array(object({ actionId: id, state: choice(...ACTION_STATES), revision: nullable(integer()) }), 100),
  unresolved_questions: array(anchoredFact, 50), next_step: anchoredFact,
  injection_flags: array(object({ messageId: id, reason: text(300) }), 50),
})

export interface ActionReceipt {
  actionId: string
  sessionId: string
  ownerUid: number
  kind: 'track_change' | 'playback_open'
  state: ActionState
  eventSeq: number
  updatedAt: number
  evidence: 'preview' | 'user_click' | 'server_readback' | 'navigation' | 'player_event' | 'error' | 'timeout'
  errorCode: AgentErrorCode | null
  userReportedSuccess: boolean
}

export interface AgentUsage {
  operation: 'model' | 'tool' | 'compact'
  provider: 'server' | 'byok'
  model: string
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  durationMs: number
  resultCount: number
  estimatedCost: number | null
  currency: string | null
  priceVersion: string | null
}

export interface AgentSession {
  id: string
  ownerUid: number
  title: string
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  revision: number
  activeSummaryVersion: number | null
  contextTier: ContextTier
  currentBgmId: number | null
  provider: 'server' | 'byok'
  model: string
  lastEventSeq: number
}

export interface AgentMessage {
  id: string
  sessionId: string
  ownerUid: number
  seq: number
  role: 'user' | 'assistant'
  body: string
  status: 'streaming' | 'completed' | 'failed' | 'cancelled'
  sourceIds: string[]
  toolSummaries: { tool: AgentToolName; status: 'ok' | AgentErrorCode; summary: string }[]
  actionIds: string[]
  createdAt: number
  pinned: boolean
  usage: AgentUsage[]
}

export interface ConfirmedPreference {
  id: string
  ownerUid: number
  category: 'tone' | 'liked_tags' | 'avoided_tags' | 'recommendation_focus'
  value: string
  revision: number
  confirmedAt: number
  confirmationMessageId: string
}

export interface AnchoredFact {
  value: string
  messageIds: string[]
  sourceIds: string[]
  certainty: 'confirmed' | 'readback' | 'observed' | 'unknown'
}

export interface SummaryState {
  task_goal: AnchoredFact
  confirmed_preferences: string[]
  entities: { bgmId: number; title: string; messageIds: string[] }[]
  constraints: AnchoredFact[]
  decisions: AnchoredFact[]
  source_refs: string[]
  tool_results: { tool: AgentToolName; sourceId: string; hash: string; summary: string }[]
  action_receipts: { actionId: string; state: ActionState; revision: number | null }[]
  unresolved_questions: AnchoredFact[]
  next_step: AnchoredFact
  injection_flags: { messageId: string; reason: string }[]
}

export interface SummaryVersion {
  sessionId: string
  ownerUid: number
  summary_version: number
  parentVersion: number | null
  createdAt: number
  transcriptRange: { fromSeq: number; throughSeq: number }
  provider: 'server' | 'byok'
  model: string
  method: 'openai_responses' | 'claude_compaction' | 'app_summary'
  state: SummaryState
  nativeStateRef: string | null
  quality: { schemaValid: boolean; sourceCoverage: number; criticalFactsPreserved: boolean; independentCheckPassed: boolean; injectionChecked: boolean }
  status: 'candidate' | 'active' | 'superseded' | 'failed' | 'cancelled'
  usage: AgentUsage[]
}
