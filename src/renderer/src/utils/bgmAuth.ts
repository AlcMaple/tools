// BGM 登录状态「自动检查」的节流。
//
// **不是滚动的 24 小时,而是以每天早上 8 点为界划逻辑日**:上次检查和现在落在同一个
// 「8 点 → 次日 8 点」窗口里就算今天查过、不再自动查;跨过下一个 8 点边界才重新查一次。
//
// 手动检查(设置里的按钮、chip 上点击)不受此节流约束,总是真的去查。

import type { BgmAuthStatus } from '../types/bgm'

let cachedStatus: BgmAuthStatus | null = null
let cachedAt = 0

/** 给定时刻所属逻辑日的起点(最近一个早上 8 点)。 */
function windowStart(ts: number): number {
  const d = new Date(ts)
  if (d.getHours() < 8) d.setDate(d.getDate() - 1)
  d.setHours(8, 0, 0, 0)
  return d.getTime()
}

/** 距上次检查是否跨过了 8 点边界(跨过 = 需要重新自动检查);没有缓存时也需要检查。 */
export function needsAutoVerify(): boolean {
  if (!cachedStatus) return true
  return cachedAt < windowStart(Date.now())
}

export function getCachedAuth(): BgmAuthStatus | null {
  return cachedStatus
}

/** 任何一次真实拿到的状态(自动或手动)都回填缓存,让各处显示一致。 */
export function setCachedAuth(s: BgmAuthStatus): void {
  cachedStatus = s
  cachedAt = Date.now()
}
