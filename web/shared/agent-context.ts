import { SUMMARY_STATE_SCHEMA, type ContractSchema, type SummaryState, type AgentUsage } from './agent-contracts'
import { HISTORY_ID_SCHEMA } from './agent-history'

export const CONTEXT_LIMITS = Object.freeze({
  preferences: 100, confirmedPreferences: 50, versionsPerSession: 30, jobsPerSession: 100, summaryBytes: 128 * 1024,
  nativeBytes: 256 * 1024, contextBytesPerUser: 20 * 1024 * 1024, requestsPerJob: 48,
  outputTokens: 8192, jobMs: 600_000, recentTurns: 10, retrievalMessages: 8,
})
export type ContextMethod = 'app_summary' | 'openai_responses' | 'claude_compaction'
export type CompactStage = 'queued' | 'budgeting' | 'extracting' | 'checking' | 'merging' | 'native' | 'completed' | 'failed' | 'cancelled' | 'skipped'
export interface PreferenceCard {
  id: string; category: 'tone' | 'liked_tags' | 'avoided_tags' | 'recommendation_focus'; value: string
  status: 'proposed' | 'confirmed'; revision: number; sourceMessageId: string | null
  createdAt: number; updatedAt: number; confirmedAt: number | null
}
export interface SummaryQuality {
  schemaValid: boolean; sourceCoverage: number; criticalFactsPreserved: boolean
  independentCheckPassed: boolean; injectionChecked: boolean; restoredMessageIds: string[]
}
export interface ContextSummary {
  sessionId: string; summary_version: number; parentVersion: number | null; createdAt: number
  transcriptRange: { fromSeq: number; throughSeq: number }; provider: 'server' | 'byok'; model: string
  method: ContextMethod; state: SummaryState; quality: SummaryQuality; usage: AgentUsage[]
  hasNativeState: boolean; status: 'active' | 'superseded'; origin: 'model' | 'user_edit' | 'restore'
  restoredFromVersion: number | null
}
export interface CompactJob {
  id: string; sessionId: string; requestId: string; trigger: 'manual' | 'automatic'
  stage: CompactStage; createdAt: number; updatedAt: number; expiresAt: number
  errorCode: string | null; summaryVersion: number | null; usage: AgentUsage[]
}
export type NativeWindow = { protocol: 'openai_responses'; items: unknown[] } | { protocol: 'anthropic_messages'; content: unknown[] }
export interface CompactRequest { requestId: string; expectedRevision: number }
export interface PrepareContextRequest extends CompactRequest { question: string }

const object = (properties: Record<string, ContractSchema>, required = Object.keys(properties)): ContractSchema => ({ type: 'object', properties, required, additionalProperties: false })
const integer = (minimum = 0): ContractSchema => ({ type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER })
const text = (maxLength: number): ContractSchema => ({ type: 'string', minLength: 1, maxLength })
const bool: ContractSchema = { type: 'boolean' }
const expectedRevision = integer()
export const COMPACT_SCHEMA = object({ requestId: HISTORY_ID_SCHEMA, expectedRevision })
export const PREPARE_CONTEXT_SCHEMA = object({ requestId: HISTORY_ID_SCHEMA, expectedRevision, question: { type: 'string', maxLength: 32_000 } })
export const PREFERENCE_CREATE_SCHEMA = object({
  category: { type: 'string', enum: ['tone', 'liked_tags', 'avoided_tags', 'recommendation_focus'] },
  value: text(500), sourceMessageId: HISTORY_ID_SCHEMA,
}, ['category', 'value'])
export const PREFERENCE_EDIT_SCHEMA = object({ expectedRevision, value: text(500) })
export const CONFIRM_PREFERENCE_SCHEMA = object({ expectedRevision })
export const PIN_MESSAGE_SCHEMA = object({ expectedRevision, pinned: bool })
export const CONTEXT_SETTINGS_SCHEMA = object({ expectedRevision, contextTier: { type: 'string', enum: ['64k', '128k', '256k', '1m'] }, adaptive: bool }, ['expectedRevision','contextTier'])
export const SUMMARY_EDIT_SCHEMA = object({ expectedRevision, state: SUMMARY_STATE_SCHEMA })
export const SUMMARY_RESTORE_SCHEMA = object({ expectedRevision, summaryVersion: integer(1) })
export const VERIFICATION_SCHEMA = object({
  passed: bool, missingMessageIds: { type: 'array', items: HISTORY_ID_SCHEMA, maxItems: 100, uniqueItems: true },
  contradictions: { type: 'array', items: text(300), maxItems: 20 },
})
