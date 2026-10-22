// 与 src/main/order-judge/service.ts 的 IPC 返回结构保持一致
import type { JudgeReport } from '../../../../web/shared/order-judge'

export interface OrderJudgeSettings {
  shared: boolean
  paths: Record<'profile' | 'log', OrderJudgePath[]>
  hasWebAccount: boolean
  webUsername: string
  sync: { state: 'disabled' | 'starting' | 'synced' | 'error'; message: string; at: number | null }
}

export interface OrderJudgePath {
  path: string
  device: string
  exists: boolean
  active: boolean
  updatedAt: number | null
}

export interface OrderJudgeHistoryEntry {
  id: string
  at: number
  report: JudgeReport
  order: string
  images: { file: string; name: string }[]
}

export type OrderJudgeErrorCode =
  | 'NEED_WEB' | 'BAD_INPUT' | 'SHARED_ERROR'

export type OrderJudgeResult =
  | { ok: true; entry: OrderJudgeHistoryEntry; warnings: string[] }
  | { ok: false; code: OrderJudgeErrorCode; detail?: string }

export type OrderJudgeProgress = { stage: 'links'; count: number } | { stage: 'ai' }

export type OrderJudgeConvertResult =
  | { ok: true; images: Uint8Array[]; text: string; seconds?: number }
  | { ok: false; code: 'NO_FFMPEG' | 'UNSUPPORTED' | 'FAILED'; detail?: string }
