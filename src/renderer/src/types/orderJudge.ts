// 与 src/main/order-judge/service.ts 的 IPC 返回结构保持一致
import type { JudgeReport } from '../../../../web/shared/order-judge'

export interface OrderJudgeSettings {
  hasKey: boolean
  profilePath: string
  logPath: string
  logUpdatedAt: number | null
}

export interface OrderJudgeHistoryEntry {
  id: string
  at: number
  report: JudgeReport
  order: string
  images: { file: string; name: string }[]
}

export type OrderJudgeErrorCode =
  | 'NO_KEY' | 'NO_PROFILE' | 'PROFILE_UNREADABLE'
  | 'KEY_INVALID' | 'BALANCE' | 'RATE_LIMITED' | 'PROVIDER_ERROR'
  | 'NETWORK' | 'EMPTY_RESPONSE' | 'BAD_RESPONSE' | 'BAD_INPUT'

export type OrderJudgeResult =
  | { ok: true; entry: OrderJudgeHistoryEntry; warnings: string[] }
  | { ok: false; code: OrderJudgeErrorCode; detail?: string; status?: number }

export type OrderJudgeProgress = { stage: 'links'; count: number } | { stage: 'ai' }

export type OrderJudgeConvertResult =
  | { ok: true; images: Uint8Array[]; text: string; seconds?: number }
  | { ok: false; code: 'NO_FFMPEG' | 'UNSUPPORTED' | 'FAILED'; detail?: string }
