export const FEEDBACK_CATEGORIES = { problem: '遇到问题', suggestion: '功能建议', other: '其他' } as const
export const FEEDBACK_STATUSES = { pending: '待处理', working: '处理中', resolved: '已解决' } as const
export type FeedbackCategory = keyof typeof FEEDBACK_CATEGORIES
export type FeedbackStatus = keyof typeof FEEDBACK_STATUSES
export interface FeedbackContext { page: string; platform: string; version: string; errorCode: string }
export interface FeedbackSummary { id: string; category: FeedbackCategory; status: FeedbackStatus; preview: string; createdAt: number; updatedAt: number; unread: boolean }
export interface FeedbackMessage { id: string; author: 'user' | 'admin'; body: string; createdAt: number; images: string[] }
export interface FeedbackDetail extends FeedbackSummary { messages: FeedbackMessage[]; context: FeedbackContext | null; email?: string; notifications?: { id: number; state: string }[] }
