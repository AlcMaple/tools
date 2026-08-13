/**
 * 按站点限速 + 限流页识别。
 *
 * `RateLimiter`:同一站点两次请求的最小间隔(从上一次**开始**算,不是完成)+ 随机抖动
 * 多个调用方经 `chain` 串行。可选滚动窗口配额守分钟级累计预算 —— 只压瞬时速率的话
 * 连发多笔仍会把时间窗打满。
 *
 * `LimitDetector` / `RateLimitError`:识别站点返回 HTTP 200 + 中文限流页正文的情况
 * 取出 wait-N。**这一层绝不自动重试** —— 重试会加剧站点的滑动惩罚窗口,由 UI 用倒计时
 * 把决定权交给用户(红线)。
 *
 * 限流页的 body 有毒,调用方**不能缓存**:检测器返回非 null 就意味着别持久化这份 body。
 */
import { sleep } from './http-client'

// ── Layer 1: timing throttle ──────────────────────────────────────────────────

export interface RateLimiterOptions {
  /** 两次请求开始之间的硬下限(ms)。实际等待 = `minGapMs + random(0, jitterMs)`
   *  要比站点已知阈值再留 100~200ms 的网络抖动余量。 */
  minGapMs: number
  jitterMs: number
  /** 日志里的站点名(如 "bgm"、"aowu")。 */
  name?: string
  /** 滚动窗口配额:`windowMs` 内最多放行 `maxPerWindow` 个,超额阻塞到最早一笔滑出。 */
  maxPerWindow?: number
  windowMs?: number
}

/** 一个站点一个实例——各站限额独立,别跨站共享。 */
export class RateLimiter {
  private chain: Promise<void> = Promise.resolve()
  private lastStartedAt = 0
  private opts: RateLimiterOptions
  /** 滚动窗口内每个请求的"开始"时间戳（仅当配置了 maxPerWindow 才记）。 */
  private starts: number[] = []
  /** 软节流：`softUntil` 之前，最小间隔抬高到 `softMinGapMs`（恢复初期慢跑一段）。 */
  private softMinGapMs = 0
  private softUntil = 0

  constructor(opts: RateLimiterOptions) {
    this.opts = opts
  }

  /** 软恢复:限流冷却刚过时先用更大的间隔慢跑 `durationMs`,别一恢复就满速把惩罚顶起来。 */
  softThrottle(gapMs: number, durationMs: number): void {
    this.softMinGapMs = gapMs
    this.softUntil = Date.now() + durationMs
  }

  /** 等到距上一次**开始**满足间隔为止;并发调用经 `chain` 串行。 */
  async wait(signal?: AbortSignal): Promise<void> {
    const prev = this.chain
    let release!: () => void
    this.chain = new Promise<void>((r) => {
      release = r
    })
    try {
      await prev
      // 间隔：软恢复期内取更大的 softMinGap，否则用基础 minGap，叠抖动。
      const baseGap = Date.now() < this.softUntil
        ? Math.max(this.opts.minGapMs, this.softMinGapMs)
        : this.opts.minGapMs
      const elapsed = Date.now() - this.lastStartedAt
      const target = baseGap + Math.floor(Math.random() * (this.opts.jitterMs + 1))
      if (elapsed < target) await sleep(target - elapsed, signal)

      // 滚动窗口配额：窗口已满则等最早一笔滑出窗口（守累计预算，不只压瞬时速率）。
      const { maxPerWindow, windowMs } = this.opts
      if (maxPerWindow && windowMs) {
        for (;;) {
          const cutoff = Date.now() - windowMs
          this.starts = this.starts.filter((t) => t > cutoff)
          if (this.starts.length < maxPerWindow) break
          const waitMs = this.starts[0] + windowMs - Date.now()
          await sleep(Math.max(1, waitMs), signal)
        }
        this.starts.push(Date.now())
      }

      this.lastStartedAt = Date.now()
    } finally {
      release()
    }
  }

  /** 等够间隔再跑 `fn`。计时从 `fn` **开始**推进,慢请求不会重复占用下一次的额度。 */
  async schedule<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.wait(signal)
    return fn()
  }
}

/** body 是限流页时返回还要等几秒,正常 body 返回 null。 */
export type LimitDetector = (body: string) => number | null

/** 渲染层靠它把「限流」和普通「搜索失败」区分开(见 utils/errorMessage.ts)。 */
export class RateLimitError extends Error {
  constructor(
    public readonly waitSeconds: number,
    message?: string,
  ) {
    super(message ?? `已触发限流，请等 ${waitSeconds} 秒后重试`)
    this.name = 'RateLimitError'
  }
}
