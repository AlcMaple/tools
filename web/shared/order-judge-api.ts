// 接单评估前后端共用的接口形状。方案见 docs/ideas/021-接单评估重新定位.md：
// 一个项目 = 同一个客户的同一单；客户每追加 / 调整一次需求，就多一个版本，版本只存这次新放进来的材料，
// AI 读上一版的需求清单 + 这次的材料，给出完整的新清单，服务端按条目 id 算出与上一版的差别。

import type { Brief, BriefChange } from './order-judge-brief'
import type { QuoteState } from './order-judge-sheet'
import type { Maintenance } from './order-judge-maintenance'

export interface VersionFile { file: string; name: string; size: number }

export interface Version {
  id: string
  n: number
  at: number
  text: string
  images: { file: string; name: string }[]
  files: VersionFile[]
  brief: Brief
  changes: BriefChange[]
  model: string
  quote: QuoteState
}

export interface Project {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  versions: Version[]
  maintenance: Maintenance
}

export interface JudgeState { projects: Project[]; seq: number }

export interface JudgeImage { name: string; dataUrl: string }

export type JudgeSyncEvent = { type: 'ready' | 'changed' | 'ping'; seq: number }

// /projects 和 /projects/:id/versions 的响应是 NDJSON：先报阶段，最后一行是 done 或 error
export type JudgeEvent =
  | { type: 'stage'; stage: 'links'; count: number }
  | { type: 'stage'; stage: 'ai' }
  | { type: 'done'; project: Project }
  | { type: 'error'; code: string; error: string }

export const PROJECT_LIMIT = 50
export const VERSION_LIMIT = 20
export const ATTACH_MAX_FILES = 10
export const ATTACH_MAX_BYTES = 6 * 1024 * 1024
export const ATTACH_MAX_TOTAL = 8 * 1024 * 1024
export const ATTACH_FILE_RE = /^att-\d{2}\.[a-z0-9]{1,8}$/
export const JUDGE_MAX_BODY = 20 * 1024 * 1024 // 与 nginx client_max_body_size 对齐
export const MAX_TEXT_CHARS = 200_000
export const JUDGES_PER_MINUTE = 6
