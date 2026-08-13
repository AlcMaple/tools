/**
 * api.bgm.tv 的共享客户端:统一限速 + 错误分类。detail / search(别名回退) / calendar
 * 三处共用一个 limiter —— 各自 `https.get` 时,详情 1 + 别名 8 + 周历 1 能在一秒内打出
 * 10+ 请求,直接顶到 per-IP 限流。
 *
 * 限流分层:L1 限速(本文件) → L2 滚动窗口配额 → L3 熔断(api-circuit.ts)。
 * api.bgm.tv 走标准 429 + Retry-After,不像 bgm.tv HTML 那样返 200 + 中文限流页
 * 所以这里不需要 body 检测层。
 */
import { app } from 'electron'
import { RateLimiter, RateLimitError } from '../shared/rate-limit'
import { netRequest } from '../shared/net-request'
import { ApiCircuitBreaker } from './api-circuit'
import { getBgmToken } from './credentials'

/**
 * UA 必须是 BGM 要求的 `{app-name}/{version} ({contact})`,contact 用真实公开仓库地址
 * (占位符 UA 一看就是默认模板,更容易触发风控),版本号走 `app.getVersion()` 自动同步。
 *
 * **不要换成浏览器伪装 UA**:API 端点要老实自报家门,HTML 端点才要像浏览器
 * (见 `bgm/search.ts` 的 BrowserSession)——两边期望相反。
 */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': `MapleTools/${app.getVersion()} (https://github.com/AlcMaple/tools)`,
    'Accept': 'application/json',
  }
  // 填了个人访问令牌就走登录态,限额更宽松。主搜索走 bgm.tv 网页、套不上 token
  // 由 cookie 登录态负责(见 credentials.ts)。
  const token = getBgmToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

// 500ms + 抖动:api.bgm.tv 比 HTML 搜索(2200ms)宽松,实测 500ms 没观察到限流。
// 60s / 20 个是启发式配额(BGM 没公开确切值),够正常使用,连搜多次时自动拉开节奏。
const apiLimiter = new RateLimiter({
  minGapMs: 500,
  jitterMs: 200,
  name: 'bgm-api',
  maxPerWindow: 20,
  windowMs: 60_000,
})

const apiBreaker = new ApiCircuitBreaker(apiLimiter)

// 连续「不回包」次数。BGM 限流的典型表现是**直接丢包、不回 429**,所以超时才是真正的
// 限流信号;拿到任何 HTTP 响应(含 4xx/5xx)即归零 —— 那说明连接是通的。
let consecutiveApiTimeouts = 0
const API_TIMEOUT_TRIP_THRESHOLD = 2

export async function fetchBgmApiJson<T = unknown>(url: string): Promise<T> {
  return apiLimiter.schedule(async () => {
    // 熔断闸门在 schedule 内(串行)检查:冷却中直接抛,不发请求;到期后这一发即半开试探。
    apiBreaker.guard()
    let res: Awaited<ReturnType<typeof netRequest>>
    try {
      res = await netRequest(url, { headers: buildHeaders(), timeoutMs: 10000 })
    } catch (e) {
      // 单次容忍(可能只是网络抖),连撞 N 次才开熔断 —— 之后 guard() 直接短路
      // 不用每次干等 10s,调用方据此降级到 bgm.tv HTML。
      consecutiveApiTimeouts++
      if (consecutiveApiTimeouts >= API_TIMEOUT_TRIP_THRESHOLD) {
        apiBreaker.recordTrip(0) // 超时没有 Retry-After,用阶梯冷却下限
      }
      throw e
    }
    consecutiveApiTimeouts = 0
    if (res.status === 429) {
      const retryAfter = parseInt(String(res.headers['retry-after'] ?? '30')) || 30
      apiBreaker.recordTrip(retryAfter)
      throw new RateLimitError(
        retryAfter,
        `BGM API 触发限流（HTTP 429），请等 ${retryAfter} 秒后再试`,
      )
    }
    if (res.status >= 400) {
      throw new Error(`BGM API HTTP ${res.status} for ${url}`)
    }
    apiBreaker.recordSuccess()
    return JSON.parse(res.body.toString('utf-8')) as T
  })
}
