import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, ProxyAgent, setGlobalDispatcher } from 'undici'

const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.VERCEL
const HAS_PROXY_ENV = !!(
  process.env.HTTPS_PROXY || process.env.https_proxy
  || process.env.HTTP_PROXY || process.env.http_proxy
  || process.env.ALL_PROXY || process.env.all_proxy
)

// Node 的全局 fetch（undici）默认**不读系统代理** —— 和 app 当年 Node https 直连
// fake-ip 假地址黑洞是同一个坑(红线)。
//
// 先让 fetch 认 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量（显式给了就完全尊重）。
// 生产（Vercel / VPS）到此为止：那里直连能通，或由运维显式给 env。
// 没有代理 env 时不构造实验性的 EnvHttpProxyAgent，避免本地 TUN 每次启动都刷警告；
// 自动对齐会在下面按需安装 ProxyAgent。
if (HAS_PROXY_ENV) setGlobalDispatcher(new EnvHttpProxyAgent())

// 本地开发再加一层「自动对齐浏览器」：如果没设代理 env、且直连稀饭不通（Clash TUN /
// fake-ip 黑洞），就探测本地代理并整体切过去 —— 浏览器能开稀饭，服务端就能开，不用每次
// 手动 `HTTPS_PROXY=... npm run dev`。探测顺序：macOS 系统代理 → Clash/Mihomo 外部控制器
// 报的混合端口 → 常见端口兜底；启动时每个候选都真发一次 HEAD 验证过才启用，
// 请求失败后的重新对齐只检查本地端口，再让原请求承担唯一重试。
const PROBE_URL = 'https://anime.xifanacg.com/'
const execFileAsync = promisify(execFile)
const DIRECT_AGENT = new Agent()
const PROXY_REFRESH_COOLDOWN_MS = 5_000
let activeProxyUrl: string | null = null
let proxyRefreshAt = 0
let proxyRefreshPromise: Promise<void> | null = null

// 传输层通没通只看能不能拿到响应（4xx/403 也算通，说明握手 + HTTP 层是活的）。
async function transportWorks(dispatcher?: ProxyAgent): Promise<boolean> {
  try {
    const res = await undiciFetch(PROBE_URL, {
      method: 'HEAD',
      dispatcher,
      signal: AbortSignal.timeout(4500),
    })
    return res.status > 0
  } catch {
    return false
  }
}

async function candidateProxies(): Promise<string[]> {
  const found = new Set<string>()
  // 1) macOS 系统代理 —— 浏览器勾「使用系统代理」时用的就是它
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('scutil', ['--proxy'], { timeout: 2000 })
      const read = (key: string): string | undefined =>
        stdout.match(new RegExp(`\\b${key}\\s*:\\s*(\\S+)`))?.[1]
      if (read('HTTPSEnable') === '1' && read('HTTPSProxy') && read('HTTPSPort')) {
        found.add(`http://${read('HTTPSProxy')}:${read('HTTPSPort')}`)
      }
      if (read('HTTPEnable') === '1' && read('HTTPProxy') && read('HTTPPort')) {
        found.add(`http://${read('HTTPProxy')}:${read('HTTPPort')}`)
      }
    } catch { /* 没 scutil / 没系统代理 */ }
  }
  // 2) Clash/Mihomo 外部控制器 —— TUN 模式下系统代理常是空的，但混合端口还在
  for (const port of [9090, 9097, 6170]) {
    try {
      const res = await undiciFetch(`http://127.0.0.1:${port}/configs`, { signal: AbortSignal.timeout(1000) })
      if (!res.ok) continue
      const cfg = (await res.json()) as { 'mixed-port'?: number; port?: number }
      const mixed = cfg['mixed-port'] || cfg.port
      if (mixed && mixed > 0) found.add(`http://127.0.0.1:${mixed}`)
    } catch { /* 没有控制器 */ }
  }
  // 3) 常见本地代理端口兜底
  for (const port of [7890, 7897, 7899, 1087, 8889, 8888, 6152]) found.add(`http://127.0.0.1:${port}`)
  return [...found]
}

function localProxyReachable(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    const port = Number(target.port)
    if (!target.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false)
    return new Promise((resolve) => {
      const socket = createConnection({ host: target.hostname, port })
      const finish = (ok: boolean): void => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(500, () => finish(false))
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    })
  } catch {
    return Promise.resolve(false)
  }
}

async function alignProxy(mode: 'startup' | 'recovery'): Promise<boolean> {
  if (IS_PRODUCTION || HAS_PROXY_ENV) return false
  if (activeProxyUrl && await localProxyReachable(activeProxyUrl)) return true
  if (activeProxyUrl) setGlobalDispatcher(DIRECT_AGENT)
  activeProxyUrl = null
  if (mode === 'startup' && await transportWorks()) return true // 直连能通，不折腾

  for (const url of await candidateProxies()) {
    if (!await localProxyReachable(url)) continue
    let agent: ProxyAgent
    try {
      agent = new ProxyAgent(url)
    } catch {
      continue
    }
    if (mode === 'recovery' || await transportWorks(agent)) {
      setGlobalDispatcher(agent)
      activeProxyUrl = url
      console.log(`[http] 直连稀饭不通，已自动改走本地代理 ${url}（与浏览器一致）`)
      return true
    }
  }
  if (mode === 'startup') {
    console.warn('[http] 直连稀饭不通，也没探到可用的本地代理 —— 用 Clash TUN 时请设 HTTPS_PROXY 或开启混合端口')
  }
  return false
}

// 各抓取模块先等启动探测定盘，避免首个请求抢在本地代理对齐前走直连。
export const proxyReady: Promise<void> = alignProxy('startup').then(() => undefined, () => undefined)

// 只在真实请求出现传输层失败时重新对齐一次；并发请求共用同一个探测，5 秒内不重复。
// 不做定时探活，也不在这里额外访问源站；候选端口确认后由原请求承担唯一重试。
export function refreshProxyAfterFailure(): Promise<void> {
  if (IS_PRODUCTION || HAS_PROXY_ENV) return Promise.resolve()
  const now = Date.now()
  if (proxyRefreshPromise) return proxyRefreshPromise
  if (now - proxyRefreshAt < PROXY_REFRESH_COOLDOWN_MS) return Promise.resolve()
  proxyRefreshAt = now
  proxyRefreshPromise = alignProxy('recovery')
    .then(() => undefined, () => undefined)
    .finally(() => { proxyRefreshPromise = null })
  return proxyRefreshPromise
}

export interface FetchJsonOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  method?: 'GET' | 'POST'
  body?: unknown // 给了就 JSON 序列化并自动带 Content-Type（BGM 的 v0 搜索是 POST）
}

// 传输层瞬时抖动（连接被重置 / DNS 抖 / 双栈赛跑失败）允许**单次**重试 —— 这是
// AI_GUIDELINES 里唯一放行的代码层重试。应用层失败（4xx/5xx）不在此列，直接抛给上层，
// 由 UI 让用户决定何时重试，绝不自动重试加重限流。
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // HTTP 错误后面带完整 URL；用户名里若恰好含 network/timeout，不能因此把 4xx 误判成传输抖动。
  if (/^HTTP \d{3}\b/.test(msg)) return false
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|terminated|network/i.test(msg)
}

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { headers = {}, timeoutMs = 10000, method = 'GET', body } = opts
  const run = async (): Promise<T> => {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return (await res.json()) as T
  }
  try {
    return await run()
  } catch (err) {
    if (isTransient(err)) {
      await refreshProxyAfterFailure()
      return run() // 单次瞬时重试；重新对齐不另加一轮
    }
    throw err
  }
}
