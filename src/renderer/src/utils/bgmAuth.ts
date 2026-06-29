// BGM 登录状态的「自动检查」节流 —— 进动漫查询 tab 时是否需要重新自动校验。
//
// 规则不是滚动的真实 24h,而是以**每天早上 8 点**为界划「逻辑日」:8 点前算
// 前一天。只要上次检查和现在落在同一个「8点→次日8点」窗口里,就算今天已查过,
// 不再自动查;一旦跨过下一个 8 点边界就重新查一次。
// 例:28 日查过 → 29 日 8 点后首次打开才会再查;29 日 7 点查的算 28 日窗口,
// 29 日 8 点后打开仍会再查。
//
// 手动检查(设置里的「检查」、chip 上点击)不受此节流约束,总是真的去查。

import type { BgmAuthStatus } from '../types/bgm'

let cachedStatus: BgmAuthStatus | null = null
let cachedAt = 0

/** 给定时刻所属「逻辑日」的起点(最近一个早上 8 点)的时间戳。 */
function windowStart(ts: number): number {
  const d = new Date(ts)
  if (d.getHours() < 8) d.setDate(d.getDate() - 1)
  d.setHours(8, 0, 0, 0)
  return d.getTime()
}

/** 自上次检查后是否跨过了 8 点边界(跨过=需要重新自动检查)。无缓存也需检查。 */
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
