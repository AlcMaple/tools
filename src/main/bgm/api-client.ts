/**
 * 共享的 api.bgm.tv 客户端 —— 给所有 BGM REST API 请求加统一的限速 +
 * 错误分类。三个调用方共享一个 RateLimiter：
 *
 *   - detail.ts          : `/v0/subjects/{id}` + `/v0/subjects/{id}/persons`
 *   - search.ts          : fetchAliases (`/v0/subjects/{id}`，别名回退分支)
 *   - calendar.ts        : `/calendar`
 *
 * 之前每处都自己 `https.get`，几个端点在同一个 IP 下连发就有可能把 BGM 那
 * 边的 per-IP 限流触发（详情进一个 → 别名查 8 条 → 周历刷新 = 10+ 请求
 * 一秒内打出去）。改成走这个共享 limiter 后，所有调用串行节流到 ~500ms
 * 间隔，BGM 那边接受度高很多。
 *
 * 限流响应处理：
 * - HTTP 429: 抛 `RateLimitError`（renderer 的 errorMessage 会识别）
 * - HTTP 5xx: 抛普通 Error，由 friendly classifier 归到"服务器异常"
 * - HTTP 4xx (非 429): 抛普通 Error
 * - 网络层 / 超时 / JSON parse: 抛原生 Error 透传，friendly classifier 会归到
 *   "连不上服务器"
 *
 * 注意：api.bgm.tv 不像 bgm.tv 搜索那样会返 HTTP 200 + 中文限流页，
 * 它走标准 HTTP 429 + Retry-After 头，所以这里只需要 timing 节流 +
 * HTTP 429 探测即可，不需要 body 检测层。
 */
import { app } from 'electron'
import { RateLimiter, RateLimitError } from '../shared/rate-limit'
import { netRequest } from '../shared/net-request'
import { ApiCircuitBreaker } from './api-circuit'

/**
 * BGM 官方明确要求第三方调用 api.bgm.tv 时带规范 User-Agent：
 *
 *     {app-name}/{version} ({contact})
 *
 * contact 可以是 GitHub 仓库 URL、邮箱、或主页地址 —— 用来在限流 / 滥用
 * 排查时联系到开发者。
 *
 * 历史踩坑：之前用过 `tools/1.0 (github.com/user/tools)` 这种占位符:
 *   - `user/tools` 是假 path，BGM 一查就知道是默认模板，触发风控概率高
 *   - 1.0 写死，版本号迭代后 UA 不变，运营上没法区分版本
 * 现在版本号走 `app.getVersion()` 自动跟 package.json 同步，contact 是
 * 真实公开仓库地址。
 *
 * **不要换成 Chrome 浏览器伪装 UA** —— api.bgm.tv 跟 bgm.tv HTML 期望相反：
 * HTML 端点要你像浏览器（见 `bgm/search.ts` 的 BrowserSession），API 端点
 * 要你**老老实实**自报家门。混了浏览器 UA 调 API 反而更容易被风控。
 */
function buildHeaders(): Record<string, string> {
  return {
    'User-Agent': `MapleTools/${app.getVersion()} (https://github.com/AlcMaple/tools)`,
    'Accept': 'application/json',
  }
}

// 500ms 间隔 + 200ms 抖动 —— api.bgm.tv 比 HTML 搜索宽松（HTML 是 2200ms),
// 实测 500ms 没观察到限流。再激进就有风险，再松就达不到防御目的。
//
// 008 阶段加 L2 滚动窗口配额：60s 内最多 20 个请求。单次别名回退最多 4 个、
// 详情 2 个，正常用够；连搜多次时自动拉开节奏，不会一口气吃光分钟级预算。
// （N 是启发式，BGM 没公开确切配额，先给稳值，按体感再调。）
const apiLimiter = new RateLimiter({
  minGapMs: 500,
  jitterMs: 200,
  name: 'bgm-api',
  maxPerWindow: 20,
  windowMs: 60_000,
})

// L3 熔断器：429 后停止投喂 API、阶梯冷却、半开试探恢复（详见 api-circuit.ts）。
const apiBreaker = new ApiCircuitBreaker(apiLimiter)

/**
 * 拉一个 api.bgm.tv 端点的 JSON 数据。所有调用排进同一个限速队列。
 *
 * **不做应用层自动重试**：任何 HTTP 失败都直接抛到 UI，由用户通过
 * Try again 按钮（5xx 错误）或倒计时按钮（429 限流）决定何时重试。这样：
 *
 *   - 用户始终知道发生了什么（不黑盒等几秒）
 *   - 永远不会因为代码自动重试加剧限流
 *   - 代码大幅简化
 *
 * @throws RateLimitError  HTTP 429。message 包含 Retry-After 秒数（站点没给
 *                          就 fallback 30s）。
 * @throws Error           HTTP 4xx（非 429）/ 5xx / 超时 / JSON parse 失败。
 *                          原始错误信息传给上层让 errorMessage classifier 分类。
 */
export async function fetchBgmApiJson<T = unknown>(url: string): Promise<T> {
  return apiLimiter.schedule(async () => {
    // 熔断闸门在 schedule 内（串行）检查 —— 冷却中直接抛 RateLimitError（UI 倒计时），
    // 不再发请求；冷却到期后这一发即「半开试探」。
    apiBreaker.guard()
    // 走 Electron net（Chromium 网络栈）—— 自动用系统代理，修掉 Node https
    // 不走代理、直连 fake-ip 假地址导致的冷启动超时。详见 shared/net-request.ts。
    const res = await netRequest(url, { headers: buildHeaders(), timeoutMs: 10000 })
    if (res.status === 429) {
      const retryAfter = parseInt(String(res.headers['retry-after'] ?? '30')) || 30
      apiBreaker.recordTrip(retryAfter) // 开熔断 + 阶梯冷却 + 持久化
      throw new RateLimitError(
        retryAfter,
        `BGM API 触发限流（HTTP 429），请等 ${retryAfter} 秒后再试`,
      )
    }
    if (res.status >= 400) {
      throw new Error(`BGM API HTTP ${res.status} for ${url}`)
    }
    apiBreaker.recordSuccess() // 半开试探成功则关闸 + 软恢复
    return JSON.parse(res.body.toString('utf-8')) as T
  })
}
