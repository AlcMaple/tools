// 与 src/main/order-judge/service.ts 的 IPC 返回结构保持一致
import type { JudgeEvent, Project } from '../../../../web/shared/order-judge-api'
import type { MarketStat } from '../../../../web/shared/order-judge-sheet'

export interface OrderJudgeView { loggedIn: boolean; username: string; accountId: number; projects: Project[]; market?: MarketStat[] }

export interface OrderJudgeOrganizeInput {
  projectId: string | null
  clientType: string
  text: string
  images: { name: string; dataUrl: string }[]
  files: { name: string; data: string }[]
}

export type OrderJudgeStage = Extract<JudgeEvent, { type: 'stage' }>

export type OrderJudgeOrganizeResult =
  | { ok: true; project: Project }
  | { ok: false; code: string; error: string }

export type OrderJudgeConvertResult =
  | { ok: true; images: Uint8Array[]; text: string; seconds?: number }
  | { ok: false; code: 'NO_FFMPEG' | 'UNSUPPORTED' | 'FAILED'; detail?: string }
