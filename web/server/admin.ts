// 管理员判定：反馈管理、重置账号共用同一套名单（环境变量 ID 列表，或绑定并验证过的指定邮箱）。
import { db } from './db'

const adminIds = (): Set<number> =>
  new Set((process.env.FEEDBACK_ADMIN_USER_IDS ?? '').split(',').map(v => Number(v.trim())).filter(v => Number.isSafeInteger(v) && v > 0))

export function isAdminUid(uid: number): boolean {
  if (adminIds().has(uid)) return true
  const email = process.env.FEEDBACK_ADMIN_EMAIL?.trim().toLowerCase()
  if (!email) return false
  return !!db.prepare("SELECT 1 FROM users WHERE id=? AND lower(email)=? AND email_verified_at IS NOT NULL AND email_verified_at <> ''").get(uid, email)
}
