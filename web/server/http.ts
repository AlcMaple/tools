import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

// Node 的全局 fetch（undici）默认**不读系统代理** —— 和 app 当年 Node https 直连
// fake-ip 假地址黑洞是同一个坑（见 CLAUDE.md 网络红线）。这里让 fetch 认
// HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量：
//   - 本地开发若 Clash 是「系统代理模式(非 TUN)」导致直连黑洞，跑之前设
//     `HTTPS_PROXY=http://127.0.0.1:7890`（换成你 Clash 的 HTTP 端口）即可。
//   - TUN 模式 / Vercel 上没这些环境变量 → 直连，无副作用。
// 这就是 012「抓取复用策略」里说的「可挂代理的传输层」在 serverless 路线下的形态。
setGlobalDispatcher(new EnvHttpProxyAgent())

export interface FetchJsonOptions {
  headers?: Record<string, string>
  timeoutMs?: number
}

// 传输层瞬时抖动（连接被重置 / DNS 抖 / 双栈赛跑失败）允许**单次**重试 —— 这是
// AI_GUIDELINES 里唯一放行的代码层重试。应用层失败（4xx/5xx）不在此列，直接抛给上层，
// 由 UI 让用户决定何时重试，绝不自动重试加重限流。
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|terminated|network/i.test(msg)
}

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { headers = {}, timeoutMs = 10000 } = opts
  const run = async (): Promise<T> => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return (await res.json()) as T
  }
  try {
    return await run()
  } catch (err) {
    if (isTransient(err)) return run() // 单次瞬时重试
    throw err
  }
}
