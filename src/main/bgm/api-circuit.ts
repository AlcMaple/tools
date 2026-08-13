/**
 * api.bgm.tv 的限流熔断器。
 *
 * BGM 的限流不是「这一秒发太快」那么简单 —— 它有**滑动惩罚计数器**(24~48h),触发后阈值
 * 越来越低。光靠限速器的间隔压不住:按中文别名搜 → 掉进别名回退 → 一次几个突发 → 429 →
 * 之后正常使用继续投喂 → 计数器一直被顶着 → 长期不可用。
 *
 * 所以熔断器的职责是**429 后停止投喂一段时间**,让计数器自然衰减,冷却到点再用一个自然请求
 * 试探恢复。**绝不主动探测**。
 *
 *   closed     正常放行
 *   open       冷却中,直接拒(抛给上层 → UI 倒计时)
 *   half-open  冷却到点,放行下一个自然请求当试探;成功则关闸并让限速器软恢复慢跑一段
 *              再 429 则升级冷却重新 open
 *
 * 阶梯冷却:短期内反复触发就升级时长,封顶 48h 对齐 BGM 的惩罚窗口;距上次触发足够久的
 * 孤立触发则等级归零。
 *
 * 状态要**持久化**:否则一重启又去捅 API,把刚要衰减的惩罚计数器重新顶起来,前功尽弃。
 */
import { RateLimitError } from '../shared/rate-limit'
import type { RateLimiter } from '../shared/rate-limit'
import { JsonStore } from '../shared/json-store'

// 阶梯冷却时长,按惩罚等级取值,封顶 48h。
const MIN = 60_000
const HOUR = 60 * MIN
const COOLDOWNS_MS = [5 * MIN, 30 * MIN, 2 * HOUR, 12 * HOUR, 48 * HOUR]
// 距上次触发超过这个时长的触发算「孤立」,惩罚等级归零重算。
const RESET_AFTER_MS = 24 * HOUR
// 软恢复:刚恢复后用更大的间隔慢跑这么久。
const SOFT_GAP_MS = 1500
const SOFT_DURATION_MS = 10 * MIN

interface BreakerState {
  /** 冷却到期时间戳,0 = closed。 */
  openUntil: number
  /** 惩罚等级(0 = 新鲜),决定本次冷却取哪一档。 */
  level: number
  /** 上次触发时间戳,用于判断「孤立触发」。 */
  lastTripAt: number
}

export class ApiCircuitBreaker {
  // 走 JsonStore:内存是权威值(同步读,请求热路径不碰盘),触发/恢复时异步合并落盘。
  private store = new JsonStore<BreakerState>('bgm_api_breaker.json', (raw) => {
    const r = raw && typeof raw === 'object' ? (raw as Partial<BreakerState>) : {}
    return {
      openUntil: Number(r.openUntil) || 0,
      level: Number(r.level) || 0,
      lastTripAt: Number(r.lastTripAt) || 0,
    }
  })

  /** 软恢复要作用到的限速器（恢复后给它施加更大间隔慢跑一段）。 */
  constructor(private limiter: RateLimiter) {}

  private get state(): BreakerState {
    return this.store.current()
  }

  /** 当前是否处于冷却中（open 且未到期）。 */
  isCoolingDown(): boolean {
    return this.state.openUntil > 0 && Date.now() < this.state.openUntil
  }

  /** 还要冷却多少秒（向上取整，最小 1）。 */
  remainingSeconds(): number {
    return Math.max(1, Math.ceil((this.state.openUntil - Date.now()) / 1000))
  }

  /**
   * 发请求前的闸门。冷却中 → 抛 RateLimitError（UI 倒计时）；
   * 否则放行（closed 正常 / 到期后这一发即半开试探）。
   * **必须在限速器的串行 schedule 内调用**，保证状态读写不竞争。
   */
  guard(): void {
    if (this.isCoolingDown()) {
      const secs = this.remainingSeconds()
      const mins = Math.ceil(secs / 60)
      throw new RateLimitError(secs, `BGM 触发限流，冷却中，约 ${mins} 分钟后自动恢复`)
    }
  }

  /** 收到 429：开熔断、升级冷却、持久化。retryAfterSec 仅作下限参考。 */
  recordTrip(retryAfterSec: number): void {
    const now = Date.now()
    // 孤立触发（距上次很久）→ 等级归零重算；否则逐级升级。
    if (now - this.state.lastTripAt > RESET_AFTER_MS) this.state.level = 0
    this.state.level = Math.min(this.state.level + 1, COOLDOWNS_MS.length)
    const stepMs = COOLDOWNS_MS[this.state.level - 1]
    // 阶梯冷却为主，retry-after 太短不足以让滑动计数器衰减，只当下限兜底。
    const cooldownMs = Math.max(stepMs, (retryAfterSec || 0) * 1000)
    this.state.openUntil = now + cooldownMs
    this.state.lastTripAt = now
    this.store.set(this.state)
  }

  /** 请求成功：若是半开试探成功，则关闸 + 给限速器施加软恢复。 */
  recordSuccess(): void {
    // openUntil>0 且已到期 → 这次是半开试探，成功即恢复。
    if (this.state.openUntil > 0 && Date.now() >= this.state.openUntil) {
      this.state.openUntil = 0
      // level 不立刻清零：短期内再触发仍按上一级升级；靠 RESET_AFTER 自然衰减。
      this.store.set(this.state)
      this.limiter.softThrottle(SOFT_GAP_MS, SOFT_DURATION_MS)
    }
  }
}
