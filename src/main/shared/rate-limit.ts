/**
 * Per-host rate limiter + body-based limit-page detector.
 *
 * 设计意图：
 *
 *   `RateLimiter`（timing throttle）
 *     串行链保证同一站点两次请求之间的**最小间隔**，从上一次"开始"算起
 *     （不是完成）。带随机抖动避免 bot-like 规律。多个调用者通过 chain
 *     串行 —— 任何一个在 penalty-box 等待时，其他人排在它后面等。
 *
 *   `LimitDetector` + `RateLimitError`
 *     检测站点返回 HTTP 200 + 中文限流页正文（"您在 N 秒内只能搜索一次"）的
 *     情况，提取 wait-N。检测到限流的调用方直接 throw `RateLimitError(waitN)`,
 *     **不在网络层自动重试** —— 由 UI 通过 CountdownRetryButton 把决定权交给
 *     用户，倒计时归零后用户主动点重试。
 *
 * **历史踩坑**：早期版本有 `withRateLimitRetry`（检测到限流页 → sleep → 自动
 * 重试一次），算上网络层 retry + 5xx retry + 限流 retry 最坏 8 次请求，**严重
 * 加剧** BGM 的滑动惩罚窗口。003 阶段全部撤掉，原函数 `withRateLimitRetry` /
 * `RateLimitRetryOptions` 已删除，**不要再加回来**。
 *
 * **重要**：LIMIT 页 body 不能被调用方缓存。检测器返回非 null 即意味着"这个
 * body 是有毒的，不要持久化"。已经走缓存的调用方应在保存前先调一次检测器。
 */
import { sleep } from './http-client'

// ── Layer 1: timing throttle ──────────────────────────────────────────────────

export interface RateLimiterOptions {
  /** Hard floor between request starts, in ms. The actual wait is
   * `minGapMs + random(0, jitterMs)`. Set above the site's known threshold
   * with a safety margin for network jitter (typically 100-200ms). */
  minGapMs: number
  /** Random additional delay on top of `minGapMs`. Keeps cadence non-regular. */
  jitterMs: number
  /** Display name for log messages (e.g. "bgm", "aowu"). */
  name?: string
  /** 滚动窗口配额（可选）：`windowMs` 内最多放行 `maxPerWindow` 个请求。
   * 用来守住"分钟级累计预算"——光靠 minGap 只压瞬时速率，连发多笔仍会把
   * 时间窗内的总量打满。超额请求阻塞到窗口里最早一笔滑出为止。 */
  maxPerWindow?: number
  windowMs?: number
}

/**
 * Module-scope `lastStartedAt` clock with chain-serialized waiters. One
 * instance per host (don't share across hosts — they have independent limits).
 */
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

  /**
   * 临时抬高最小间隔（软恢复用）：刚从限流冷却恢复后，先以更大的间隔慢跑
   * `durationMs`，再自动回落到 `minGapMs`，避免一恢复就满速把滑动惩罚顶起来。
   */
  softThrottle(gapMs: number, durationMs: number): void {
    this.softMinGapMs = gapMs
    this.softUntil = Date.now() + durationMs
  }

  /**
   * Block until enough time has passed since the previous call's start.
   * Reentrancy-safe: concurrent callers serialize through `chain`.
   */
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

  /**
   * Convenience wrapper: wait for the gap budget, then run `fn`. Returns the
   * function's value. The clock advances at the START of `fn`, not when it
   * resolves — long-running fetches don't double-count against the next call.
   */
  async schedule<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.wait(signal)
    return fn()
  }
}

// ── Layer 2: body-based limit-page detection ──────────────────────────────────
//
// 注意：**不**在这一层做自动重试。检测器只负责"识别这是不是限流页"，
// 调用方拿到非 null 返回值后**直接** throw `RateLimitError`，UI 显示倒计时
// 给用户决定何时手动 retry。详细历史见文件顶部 doc comment。

/**
 * Returns retry-after-seconds when the response body indicates a rate-limit
 * page (typically the site responded HTTP 200 with a "too fast" message),
 * or null if the body is normal.
 */
export type LimitDetector = (body: string) => number | null

/**
 * Sentinel error class. Callers can `e instanceof RateLimitError` (or the
 * renderer-side `String(err).startsWith(...)`) to surface a friendlier UI
 * message instead of a generic "search failed".
 */
export class RateLimitError extends Error {
  constructor(
    public readonly waitSeconds: number,
    message?: string,
  ) {
    super(message ?? `已触发限流，请等 ${waitSeconds} 秒后重试`)
    this.name = 'RateLimitError'
  }
}
