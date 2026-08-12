/**
 * Cookie-aware HTTP session.
 *
 * 传输层走 Electron `net`(`netRequest`)而非 Node `https` —— 跟项目其它抓取
 * 一致(见 net-request.ts 的长注释):Node `https` 不读系统代理,用户开 Clash
 * 系 fake-ip 代理时直连 198.18.x 假地址导致黑洞超时;且其 TLS 指纹更容易被
 * Cloudflare 判为可疑而频繁弹人机校验。net 走 Chromium 网络栈,自动读系统代理 +
 * 浏览器一致的指纹,从根上修掉这两类问题。
 *
 * cookie jar(name=value 扁平 Map)+ 文件持久化 + **逐跳手动跟重定向**(每跳都
 * ingest Set-Cookie)的行为与历史实现保持 1:1 —— 验证码门依赖跨域 301 那一跳设
 * 的 cookie,所以这里特意用 redirect:'manual' 自己跟,而不是让 net 自动 follow
 * (自动 follow 只回最后一跳的响应头,中间跳的 Set-Cookie 会丢)。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { app } from 'electron'
import { netRequest } from './net-request'

export interface HttpResponse {
  status: number
  body: string
  bodyBuffer: Buffer
}

type ResHeaders = Record<string, string | string[] | undefined>

export class HttpSession {
  private cookies = new Map<string, string>()
  private readonly cookieFile: string
  private readonly baseHeaders: Record<string, string>

  constructor(sessionName: string, baseHeaders: Record<string, string>) {
    this.cookieFile = join(app.getPath('userData'), `.${sessionName}_cookies.json`)
    this.baseHeaders = baseHeaders
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.cookieFile)) {
        const data = JSON.parse(readFileSync(this.cookieFile, 'utf-8')) as Record<string, string>
        for (const [k, v] of Object.entries(data)) this.cookies.set(k, v)
      }
    } catch { /* ignore */ }
  }

  save(): void {
    try {
      writeFileSync(this.cookieFile, JSON.stringify(Object.fromEntries(this.cookies)))
    } catch { /* ignore */ }
  }

  getCookieString(): string {
    const parts: string[] = []
    this.cookies.forEach((v, k) => parts.push(`${k}=${v}`))
    return parts.join('; ')
  }

  private updateFromSetCookie(headers: ResHeaders): void {
    const sc = headers['set-cookie']
    const list = Array.isArray(sc) ? sc : sc ? [sc] : []
    for (const s of list) {
      const part = s.split(';')[0].trim()
      const eq = part.indexOf('=')
      if (eq > 0) this.cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  }

  /** 读某个 cookie 的当前值(没有则 undefined)——登录态判断靠某个特定 cookie 是否存在。 */
  getCookie(name: string): string | undefined {
    return this.cookies.get(name)
  }

  /**
   * 兼容旧 cookie 文件时导出最小的 name/value 集合。属性原本就没有落盘，调用方
   * 必须按目标站点重新绑定 domain/path，不能把这里当成浏览器 cookie 的完整备份。
   */
  getCookieEntries(): Array<{ name: string; value: string }> {
    return Array.from(this.cookies, ([name, value]) => ({ name, value }))
  }

  /** 用同一站点的新 cookie 集合替换旧的扁平 jar，供迁移后的会话向后兼容。 */
  replaceCookies(cookies: Iterable<{ name: string; value: string }>): void {
    this.cookies.clear()
    for (const cookie of cookies) {
      if (cookie.name) this.cookies.set(cookie.name, cookie.value)
    }
  }

  /**
   * 逐跳跟重定向(最多 5 跳),每跳都先 ingest Set-Cookie。3xx 且带 Location 就
   * 跟下一跳,否则返回该跳的 status/body。这套逻辑与历史 Node-https 版完全一致,
   * 只是底层 fetch 换成了 netRequest。get/post 共用,差别只是 method/body。
   */
  private async request(
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    extraHeaders: Record<string, string>,
  ): Promise<HttpResponse> {
    let current = url
    for (let redirectsLeft = 5; ; redirectsLeft--) {
      const headers = {
        ...this.baseHeaders,
        Cookie: this.getCookieString(),
        ...extraHeaders,
      }
      // net 自己管理重定向才能拿原始响应,这里要逐跳读 Location,所以用 manual。
      const res = await netRequest(current, { method, headers, body, timeoutMs: 15000, redirect: 'manual' })
      this.updateFromSetCookie(res.headers)

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers['location']
        const location = Array.isArray(loc) ? loc[0] : loc
        if (location) {
          if (redirectsLeft <= 0) throw new Error('Too many redirects')
          current = new URL(location, current).href
          continue
        }
      }

      return { status: res.status, body: res.body.toString('utf-8'), bodyBuffer: res.body }
    }
  }

  async get(url: string, extraHeaders: Record<string, string> = {}): Promise<HttpResponse> {
    return this.request('GET', url, undefined, extraHeaders)
  }

  /** 表单 POST(如登录):body 是 urlencoded 串,Content-Type 自动带上。 */
  async post(url: string, body: string, extraHeaders: Record<string, string> = {}): Promise<HttpResponse> {
    return this.request('POST', url, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...extraHeaders,
    })
  }
}
