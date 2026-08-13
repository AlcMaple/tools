/**
 * 主进程 HTTP 客户端 —— 走 Electron `net`(Chromium 网络栈)。
 *
 * **红线:主进程所有 HTTP 都必须走这里,不许用 Node `https` / axios / node-fetch。**
 * Node `https` 不读系统代理:用户开着 Clash 系 fake-ip 代理时,bgm.tv 被解析成不可路由的
 * 198.18.x,直连就是黑洞;`net` 自动跟随系统代理 / PAC,行为与浏览器一致。
 *
 * 几个约定:
 *   - 调用方的 `Accept-Encoding` 会被剔掉 —— 手动设了它 Chromium 就不再自动解压
 *     剔掉后拿到的 body 已是明文,不用再 decodeBody。
 *   - timeout 自己实现(net 的 ClientRequest 没有 setTimeout)。
 *   - 重定向默认 follow;要读 3xx 的 Location 传 'manual'。
 *   - 这层只管传输:限速和重试都留在调用方。
 */
import { net } from 'electron'

export interface NetResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

// Chromium 自己管的头,手动 setHeader 会抛 net::ERR_INVALID_ARGUMENT 或被忽略。
const NET_MANAGED_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding'])

export interface NetOptions {
  method?: string
  headers?: Record<string, string>
  /** 请求体（POST/PUT）。Content-Length 由 net 自动算，别自己设。 */
  body?: string | Buffer
  /** 默认 12000ms。到点 abort 并 reject(Error('timeout'))。 */
  timeoutMs?: number
  /** 'follow'（默认）自动跟 3xx；'manual' 返回 3xx 原始响应。 */
  redirect?: 'follow' | 'manual'
  /**
   * 用某个 session 的 cookie 罐发请求（如 `persist:bili` 里的 B 站登录态）。
   * 不传走默认 session。传了就自动开 `useSessionCookies` —— net 默认**不带**
   * 该 session 的 cookie（`useSessionCookies` 缺省 false），而传 session 进来
   * 的唯一目的就是用它的登录态，两个开关分开只会制造「传了 session 却没带
   * cookie」的静默失败。
   */
  session?: Electron.Session
}

/**
 * 发一个走 Chromium 网络栈（系统代理）的 HTTP 请求。
 *
 * 成功 resolve `{ status, headers, body }`（body 已解压成明文）。
 * 超时 / abort / 传输层错误一律 reject 原生 Error，由调用方分类。
 */
export function netRequest(url: string, opts: NetOptions = {}): Promise<NetResult> {
  const { method = 'GET', headers = {}, body, timeoutMs = 12000, redirect = 'follow', session } = opts
  return new Promise<NetResult>((resolve, reject) => {
    let settled = false
    const finish = (cb: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cb()
    }

    const request = net.request({ method, url, redirect, session, useSessionCookies: !!session })

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
    if (body !== undefined) request.write(body)
    request.end()
  })
}
