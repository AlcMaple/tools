// 估价的小时部分：结构对齐 RadQuote（任务组 → 任务 → 小时），总小时 / 组小时由服务端按任务求和，不信模型报的总数。

export const ESTIMATE_GROUPS = [
  { key: 'discovery', name: '需求与启动', en: 'Discovery & Initiation' },
  { key: 'design', name: 'UX 与设计', en: 'UX & Design' },
  { key: 'development', name: '开发', en: 'Development' },
  { key: 'integrations', name: '第三方集成', en: 'Integrations' },
  { key: 'qa', name: '测试', en: 'QA & Testing' },
  { key: 'launch', name: '部署上线', en: 'Launch & Deployment' },
  { key: 'pm', name: '项目管理', en: 'Project Management' },
  { key: 'support', name: '上线后支持', en: 'Post-Launch Support' },
] as const

export type EstimateGroupKey = typeof ESTIMATE_GROUPS[number]['key']

export interface EstimateTask { title: string; hours: number }
export interface EstimateGroup { key: EstimateGroupKey; name: string; hours: number; tasks: EstimateTask[] }
export interface HoursEstimate { totalHours: number; taskCount: number; groups: EstimateGroup[] }

export type EstimateEvent =
  | { type: 'stage'; stage: 'links'; count: number }
  | { type: 'stage'; stage: 'scope' }
  | { type: 'scope'; tasks: number }
  | { type: 'group'; group: EstimateGroup }
  | { type: 'done'; estimate: HoursEstimate; ms: number }
  | { type: 'error'; code: string; error: string }
