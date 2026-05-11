/**
 * Per-host rate limiter + body-based limit-page detector with single-retry.
 *
 * Two layers of defense against per-IP rate limits on remote sites:
 *
 *   Layer 1 — RateLimiter (timing)
 *     A serial chain that guarantees a *minimum gap* between any two requests
 *     against the same site, measured from the moment the previous request
 *     STARTED (not finished). Adds randomized jitter so the cadence doesn't
 *     look bot-like. Concurrent callers serialize through the chain — if any
 *     one is mid-penalty-box wait, others sit behind it.
 *
 *   Layer 2 — withRateLimitRetry (detection)
 *     Some sites (e.g. bgm.tv) respond to over-pacing with HTTP 200 + a body
 *     that says "您在 N 秒内只能搜索一次". A caller supplies a detector that
 *     extracts that wait-N; we sleep + retry once; if still limited, throw.
 *
 * IMPORTANT — the LIMIT page must NOT be cached by the caller. The detector's
 * return value signals "this body is poison, don't persist it." Callers that
 * already cache successful responses should check the detector BEFORE saving.
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
}

/**
 * Module-scope `lastStartedAt` clock with chain-serialized waiters. One
 * instance per host (don't share across hosts — they have independent limits).
 */
export class RateLimiter {
  private chain: Promise<void> = Promise.resolve()
  private lastStartedAt = 0
  private opts: RateLimiterOptions

  constructor(opts: RateLimiterOptions) {
    this.opts = opts
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
      const elapsed = Date.now() - this.lastStartedAt
      const target =
        this.opts.minGapMs + Math.floor(Math.random() * (this.opts.jitterMs + 1))
      if (elapsed < target) await sleep(target - elapsed, signal)
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

// ── Layer 2: body-based limit-page detection + retry ──────────────────────────

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

export interface RateLimitRetryOptions {
  /** Extra jitter (seconds) added on top of detected wait. Default: 2-6s. */
  jitterSecMin?: number
  jitterSecMax?: number
  /** Observability hook fired when first attempt is detected as limited. */
  onLimited?: (waitSec: number) => void
}

/**
 * Run `exec` once. If the resulting body trips `detect`, sleep N + jitter, run
 * `exec` again. If the second attempt is also limited, throw `RateLimitError`.
 *
 * `exec` should return the HTML/JSON body string. Callers that have richer
 * response objects (status code, headers) should still funnel just the body
 * string here, and handle HTTP-level limit signals (429/503) separately.
 */
export async function withRateLimitRetry(
  exec: () => Promise<string>,
  detect: LimitDetector,
  opts: RateLimitRetryOptions = {},
): Promise<string> {
  const body1 = await exec()
  const wait1 = detect(body1)
  if (wait1 == null) return body1

  opts.onLimited?.(wait1)
  const jitMin = opts.jitterSecMin ?? 2
  const jitMax = opts.jitterSecMax ?? 6
  const jitter = jitMin + Math.random() * Math.max(0, jitMax - jitMin)
  await sleep((wait1 + jitter) * 1000)

  const body2 = await exec()
  const wait2 = detect(body2)
  if (wait2 == null) return body2

  throw new RateLimitError(
    wait2,
    `限流页二次返回，建议稍后再试（站点要求等待 ${wait2}s）`,
  )
}
