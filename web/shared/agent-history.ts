import {
  ACTION_STATES, ERROR_CODES, SOURCE_SCHEMA, TOOL_NAMES,
  type ActionReceipt, type AgentMessage, type AgentSession, type AgentUsage, type ContractSchema,
} from './agent-contracts'

export const HISTORY_LIMITS = Object.freeze({
  titleChars: 100, bodyChars: 32_000, requestBytes: 128 * 1024, pageSize: 30, maxPageSize: 50,
  sessionsPerUser: 200, messagesPerSession: 10_000,
  bytesPerSession: 10 * 1024 * 1024, bytesPerUser: 50 * 1024 * 1024,
  deletedRequestRetentionMs: 30 * 24 * 60 * 60 * 1000,
})

export interface HistorySource {
  sourceId: string
  kind: 'offline_index' | 'current_page' | 'calendar_cache' | 'my_tracks' | 'public_reviews' | 'public_aggregate'
  label: string
  retrievedAt: number
  bgmId?: number
  cachedAt?: number | null
}

export type HistoryAction = Pick<ActionReceipt, 'actionId' | 'kind' | 'state' | 'eventSeq' | 'updatedAt' | 'evidence' | 'errorCode' | 'userReportedSuccess'> & { summary: string }
export type HistorySession = Omit<AgentSession, 'ownerUid'> & { messageCount: number }
export type HistoryMessage = Omit<AgentMessage, 'ownerUid'> & {
  sources: HistorySource[]
  actions: HistoryAction[]
  updatedAt: number
}

export interface CreateHistorySession { requestId: string; title?: string; currentBgmId?: number | null }
export interface PatchHistorySession { expectedRevision: number; title?: string; archived?: boolean; currentBgmId?: number | null }
export interface AppendUserMessage { requestId: string; expectedRevision: number; body: string }
export interface AssistantMessageContent {
  body: string
  status: HistoryMessage['status']
  sources: HistorySource[]
  toolSummaries: AgentMessage['toolSummaries']
  actions: HistoryAction[]
  usage: AgentUsage[]
}
export interface AppendAssistantMessage extends AssistantMessageContent { requestId: string; expectedRevision: number }
export interface UpdateAssistantMessage extends AssistantMessageContent { expectedRevision: number }
export interface UpdateHistoryAction { expectedRevision: number; action: HistoryAction }
export interface SessionListQuery { limit?: number; archived?: 'active' | 'archived' | 'all'; beforeUpdatedAt?: number; beforeId?: string }
export interface MessagePageQuery { limit?: number; beforeSeq?: number; afterSeq?: number }
export interface HistorySnapshot {
  session: HistorySession
  messages: HistoryMessage[]
  nextBeforeSeq: number | null
  nextAfterSeq: number | null
}

const object = (properties: Record<string, ContractSchema>, required = Object.keys(properties)): ContractSchema =>
  ({ type: 'object', properties, required, additionalProperties: false })
const string = (maxLength: number, minLength = 1): ContractSchema => ({ type: 'string', minLength, maxLength })
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): ContractSchema => ({ type: 'integer', minimum, maximum })
const choices = (...values: string[]): ContractSchema => ({ type: 'string', enum: values })
const nullable = (schema: ContractSchema): ContractSchema => ({ anyOf: [schema, { type: 'null' }] })
const list = (items: ContractSchema, maxItems: number): ContractSchema => ({ type: 'array', items, maxItems })
export const HISTORY_ID_SCHEMA: ContractSchema = { ...string(100), pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$' }
const title: ContractSchema = { ...string(HISTORY_LIMITS.titleChars), pattern: '^[^\\u0000-\\u001f\\u007f]+$' }
const bgmId: ContractSchema = { anyOf: [integer(1), integer(-Number.MAX_SAFE_INTEGER, -1), { type: 'null' }] }
const boolean: ContractSchema = { type: 'boolean' }
const expectedRevision = integer()

export const CREATE_SESSION_SCHEMA = object({ requestId: HISTORY_ID_SCHEMA, title, currentBgmId: bgmId }, ['requestId'])
export const PATCH_SESSION_SCHEMA = object({ expectedRevision, title, archived: boolean, currentBgmId: bgmId }, ['expectedRevision'])
export const REVISION_SCHEMA = object({ expectedRevision })
export const USER_MESSAGE_SCHEMA = object({ requestId: HISTORY_ID_SCHEMA, expectedRevision, body: string(HISTORY_LIMITS.bodyChars) })
export const SESSION_LIST_SCHEMA = object({
  limit: integer(1, HISTORY_LIMITS.maxPageSize), archived: choices('active', 'archived', 'all'),
  beforeUpdatedAt: integer(), beforeId: HISTORY_ID_SCHEMA,
}, [])
export const MESSAGE_PAGE_SCHEMA = object({ limit: integer(1, HISTORY_LIMITS.maxPageSize), beforeSeq: integer(1), afterSeq: integer() }, [])

const action = object({
  actionId: HISTORY_ID_SCHEMA, kind: choices('track_change', 'playback_open'), state: choices(...ACTION_STATES),
  eventSeq: integer(), updatedAt: integer(), evidence: choices('preview', 'user_click', 'server_readback', 'navigation', 'player_event', 'error', 'timeout'),
  errorCode: nullable(choices(...ERROR_CODES)), userReportedSuccess: boolean, summary: string(600, 0),
})
export const ACTION_UPDATE_SCHEMA = object({ expectedRevision, action })
const usage = object({
  operation: choices('model', 'tool', 'compact'), provider: choices('server', 'byok'), model: string(100),
  inputTokens: nullable(integer()), cachedInputTokens: nullable(integer()), outputTokens: nullable(integer()),
  durationMs: integer(), resultCount: integer(), estimatedCost: nullable({ type: 'number', minimum: 0, maximum: 1_000_000 }),
  currency: nullable(string(20)), priceVersion: nullable(string(100)),
})
const assistantContent = {
  body: string(HISTORY_LIMITS.bodyChars, 0), status: choices('streaming', 'completed', 'failed', 'cancelled'),
  sources: list(SOURCE_SCHEMA, 30),
  toolSummaries: list(object({ tool: choices(...TOOL_NAMES), status: choices('ok', ...ERROR_CODES), summary: string(600, 0) }), 48),
  actions: list(action, 30), usage: list(usage, 100),
}
export const ASSISTANT_APPEND_SCHEMA = object({ requestId: HISTORY_ID_SCHEMA, expectedRevision, ...assistantContent })
export const ASSISTANT_UPDATE_SCHEMA = object({ expectedRevision, ...assistantContent })

export class AgentHistoryError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 413 | 429, message: string) {
    super(message)
    this.name = 'AgentHistoryError'
  }
}
