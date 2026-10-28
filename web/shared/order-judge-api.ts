// 网页版接单评估前后端共用的接口形状。

import type { JudgeReport } from './order-judge'
import type { EstimateEvent, EstimateResult } from './order-judge-estimate'

export type DocKind = 'profile' | 'log'

export interface DocMeta {
  name: string
  size: number
  updatedAt: number
  revision: number
  hash: string
  source: string
  sourcePath: string | null
}

export interface JudgeDoc extends DocMeta { content: string }
export type JudgeDocs = Record<DocKind, JudgeDoc | null>
// 本机文件是唯一来源：上传即整份覆盖，服务器不合并正文、不留候选和旧稿。
export interface DocWrite { name: string; content: string; source?: string; path?: string }
export interface DocReceipt { status: 'saved' | 'same'; revision: number; hash: string }
export interface JudgeSnapshot { profile: { revision: number; hash: string }; log: { revision: number; hash: string } | null }
// 路径列表按账号存一份：各台电脑的路径合并追加，顺序即优先级，每台电脑取第一个本机存在的文件。
// 网页（含手机）上传的文件也是其中一条：device 为 WEB_DEVICE，正文存在服务器，任何设备都「存在」。
export interface JudgePath { path: string; device: string; upload?: { size: number; updatedAt: number } }
export const WEB_DEVICE = '网页'
export type JudgePaths = Record<DocKind, JudgePath[]>
export const MAX_JUDGE_PATHS = 12
export interface JudgeSyncState { protocol: 1; accountId: number; username: string; seq: number; docs: JudgeDocs; paths: JudgePaths }
export type JudgeSyncEvent = { type: 'ready' | 'changed' | 'ping'; seq: number } | { type: 'check'; id: string }

export interface HistoryFile { file: string; name: string; size: number }

export interface HistoryEntry {
  id: string
  at: number
  report: JudgeReport
  order: string
  images: { file: string; name: string }[]
  /** 原样留存的附件（PDF / Word / 文本 / 表格等），图片和视频不在此列 */
  files?: HistoryFile[]
  snapshot?: JudgeSnapshot
  model?: string
  estimate?: EstimateResult
}

export interface JudgeState {
  docs: Record<DocKind, DocMeta | null>
  paths: JudgePaths
  history: HistoryEntry[]
  seq: number
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
  // 评估附带的估价（estimate: true），在 done / error 之前或之后都可能到，流在两边都结束后才关
  | { type: 'estimate'; event: EstimateEvent }

export const HISTORY_LIMIT = 50
export const ATTACH_MAX_FILES = 10
export const ATTACH_MAX_BYTES = 6 * 1024 * 1024
export const ATTACH_MAX_TOTAL = 8 * 1024 * 1024
export const ATTACH_FILE_RE = /^att-\d{2}\.[a-z0-9]{1,8}$/
export const DOC_MAX_BYTES = 1_000_000
export const JUDGE_MAX_BODY = 20 * 1024 * 1024 // 与 nginx client_max_body_size 对齐
export const MAX_TEXT_CHARS = 200_000
export const JUDGES_PER_MINUTE = 6
