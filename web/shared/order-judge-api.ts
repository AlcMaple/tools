// 网页版接单评估前后端共用的接口形状。

import type { JudgeReport } from './order-judge'

export type DocKind = 'profile' | 'log'

export interface DocMeta {
  name: string
  size: number
  updatedAt: number
}

export interface HistoryEntry {
  id: string
  at: number
  report: JudgeReport
  order: string
  images: { file: string; name: string }[]
}

export interface JudgeState {
  docs: Record<DocKind, DocMeta | null>
  history: HistoryEntry[]
}

export interface JudgeImage {
  name: string
  dataUrl: string
}

// /judge 的响应是 NDJSON：先报阶段，最后一行是 done 或 error
export type JudgeEvent =
  | { type: 'stage'; stage: 'links'; count: number }
  | { type: 'stage'; stage: 'ai' }
  | { type: 'done'; entry: HistoryEntry }
  | { type: 'error'; code: string; error: string }

export const HISTORY_LIMIT = 50
export const DOC_MAX_BYTES = 1_000_000
export const JUDGE_MAX_BODY = 20 * 1024 * 1024 // 与 nginx client_max_body_size 对齐
export const JUDGES_PER_MINUTE = 6
