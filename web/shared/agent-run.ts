import type { AgentToolName, AgentUsage, JsonValue } from './agent-contracts'
import { HISTORY_ID_SCHEMA, USER_MESSAGE_SCHEMA } from './agent-history'

export const RUN_LIMITS = Object.freeze({ eventsPerRun: 2048, eventBytes: 128 * 1024, checkpointBytes: 256 * 1024,
  bytesPerRun: 2 * 1024 * 1024, bytesPerUser: 10 * 1024 * 1024, runsPerSession: 100, leaseMs: 60_000,
  modelOutputBytes: 128 * 1024, answerChars: 16_000, eventPage: 100, subscribersPerUser: 2 })
export type RunState = 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'
export type RunEventKind = 'started' | 'resumed' | 'knowledge' | 'context' | 'model_started' | 'delta' | 'tool_started' | 'tool_finished' | 'soft_limit' | 'long_task' | 'completed' | 'failed' | 'cancelled' | 'paused'
export interface RunEvent { runId: string; seq: number; type: RunEventKind; data: JsonValue; createdAt: number }
export interface RunView {
  id: string; sessionId: string; state: RunState; messageId: string | null; userMessageId: string
  attempt: number; rounds: number; activeMs: number; createdAt: number; updatedAt: number
  lastEventSeq: number; code: string | null; knowledgeVersion: string; canResume: boolean
}
export interface StartRun { requestId: string; expectedRevision: number; body: string; clientVersion?: string }
export interface ResumeRun { requestId: string; expectedRevision: number; clientVersion?: string }
export const START_RUN_SCHEMA = { ...USER_MESSAGE_SCHEMA, properties: { ...USER_MESSAGE_SCHEMA.properties, clientVersion: { type: 'string' as const, maxLength: 128, minLength: 1 } } }
export const RESUME_RUN_SCHEMA = { type: 'object' as const, properties: {
  requestId: HISTORY_ID_SCHEMA, expectedRevision: { type: 'integer' as const, minimum: 0 },
  clientVersion: { type: 'string' as const, maxLength: 128, minLength: 1 },
}, required: ['requestId', 'expectedRevision'], additionalProperties: false as const }
export interface ReadToolCall { name: AgentToolName; arguments: Record<string, JsonValue> }
export interface RunCheckpoint {
  results: { call: ReadToolCall; result: JsonValue }[]
  inFlight: 'model' | 'tool' | null
  pendingCalls: ReadToolCall[]
  usage: AgentUsage[]
}
export class AgentRunError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 404 | 409 | 413 | 429 | 503 = 409) {
    super(code); this.name = 'AgentRunError'
  }
}
