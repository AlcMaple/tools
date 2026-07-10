/**
 * Electron `net` 封装 —— 给主进程的抓取统一一个走 **Chromium 网络栈**的
 * HTTP 客户端，替代裸 Node `https`。
 *
 * 为什么换（见 docs/scraping/bgm-集成参考手册）：Node `https` **不读系统代理**。
 * 用户开着 Clash/Mihomo 系 fake-ip 代理时，DNS 把 bgm.tv 解析成 198.18.x
 * 假地址，Node 直连这个不可路由的地址 → 黑洞 → 冷启动超时；而浏览器走
 * 系统代理永远正常。Electron `net` 走 Chromium 网络栈，**自动读系统代理 +
 * PAC + IPv4/IPv6 赛跑**，行为跟浏览器一致，从根上修掉「app 连不上但浏览器
 * 能开」。
 *
 * 设计要点：
 *   - **剔除调用方的 Accept-Encoding**：手动设了这个头，Chromium 就不替你
 *     自动解压（它以为你要原始字节）。剔掉后 net 用自己那套真实的压缩协商
 *     并自动解压，返回的 body 已是明文 —— 调用方不用再 decodeBody。
 *   - **自己实现 timeout**：net 的 ClientRequest 没有 setTimeout，用 setTimeout
 *     + request.abort() 兜。
 *   - **redirect 默认 follow**：net 自动跟 3xx（萌娘那种相对 Location 也照跟），
 *     省掉手动重定向逻辑。要拿 3xx 原始响应（比如读 Location）传 'manual'。
 *   - **不接 RateLimiter / 不自动重试**：节流和重试策略留在各调用方
 *     （api-client 的 RateLimiter、search 的 withTransientRetry），这层只管传输。
 */
import { net } from 'electron'

export interface NetResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

// 由 Chromium 网络栈自动管理的请求头：手动 setHeader 会抛 net::ERR_INVALID_ARGUMENT
// （或被忽略）。一律跳过，让 net 自己设。小写比较。
const NET_MANAGED_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding'])

export interface NetOptions {
  method?: string
  headers?: Record<string, string>
  /** 默认 12000ms。到点 abort 并 reject(Error('timeout'))。 */
  timeoutMs?: number
  /** 'follow'（默认）自动跟 3xx；'manual' 返回 3xx 原始响应。 */
  redirect?: 'follow' | 'manual'
}

/**
 * 发一个走 Chromium 网络栈（系统代理）的 HTTP 请求。
 *
 * 成功 resolve `{ status, headers, body }`（body 已解压成明文）。
 * 超时 / abort / 传输层错误一律 reject 原生 Error，由调用方分类。
 */
export function netRequest(url: string, opts: NetOptions = {}): Promise<NetResult> {
  const { method = 'GET', headers = {}, timeoutMs = 12000, redirect = 'follow' } = opts
  return new Promise<NetResult>((resolve, reject) => {
    let settled = false
    const finish = (cb: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cb()
    }

    const request = net.request({ method, url, redirect })

    for (const [k, v] of Object.entries(headers)) {
      // 跳过由 Chromium 网络栈自己管理的头：手动 setHeader 它们会抛
      // net::ERR_INVALID_ARGUMENT。Host/Connection 由 net 按 URL/连接池自动设；
      // Content-Length 按 body 自动算；Accept-Encoding 交给 net 协商 + 自动解压
      // （调用方设了反而拿到未解压的原始字节）。BrowserSession.headers() 会带
      // Host/Connection，所以这层必须过滤，否则 bgm:search 直接报错。
      if (NET_MANAGED_HEADERS.has(k.toLowerCase())) continue
      request.setHeader(k, v)
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error('timeout')))
      try { request.abort() } catch { /* 已结束 */ }
    }, timeoutMs)

    // redirect:'manual' 下 net **不会**把 3xx 当成 'response' 抛出来 —— 它发
    // 'redirect' 事件并挂起请求,不调 followRedirect() 就把请求作废、从 'error'
    // 抛 "Redirect was cancelled"。也就是说不接这个事件的话,'manual' 一碰到
    // 3xx 必然失败(girigiri 换域名后 301,整个源直接挂,就是这么炸的)。
    // 这里把 3xx 的 status/headers 原样 resolve 出去(body 空),让调用方
    // (HttpSession)自己读 Location、逐跳 ingest Set-Cookie 再跟下一跳。
    if (redirect === 'manual') {
      request.on('redirect', (statusCode, _method, _redirectUrl, responseHeaders) => {
        finish(() => resolve({
          status: statusCode,
          headers: responseHeaders as Record<string, string | string[] | undefined>,
          body: Buffer.alloc(0),
        }))
        try { request.abort() } catch { /* 已结束 */ }
      })
    }

    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      const resHeaders = response.headers as Record<string, string | string[] | undefined>
      const chunks: Buffer[] = []
      response.on('data', (c: Buffer) => chunks.push(c))
      response.on('end', () => finish(() => resolve({ status, headers: resHeaders, body: Buffer.concat(chunks) })))
      response.on('error', (e: Error) => finish(() => reject(e)))
    })
    request.on('error', (e: Error) => finish(() => reject(e)))
    request.on('abort', () => finish(() => reject(new Error('aborted'))))
    request.end()
  })
}
