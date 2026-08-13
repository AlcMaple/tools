/**
 * 按站点隔离的「浏览器化」HTTP 会话:UA 池 + cookie 罐 + 请求头构造。
 *
 * 一个实例绑一个 host、各有各的 cookie 罐 —— cookie 不会在站点之间串,各站的随机 UA 也互相独立。
 *
 * 反检测姿态:
 *   - UA、sec-ch-ua、sec-ch-ua-platform 对齐到**同一个** Chrome 大版本,构造时随机挑一次
 *     之后整个应用生命周期固定不变(真浏览器不会中途换 UA)。
 *   - sec-fetch-* 默认是「同源 XHR」的姿态,取 HTML 页面这类导航式请求时由调用方逐次覆盖。
 *   - cookie 罐只记 name=value 并通过 Cookie 头回放;Path / Expires / Secure 这些属性一律忽略 ——
 *     对付抓取站点常见的分析 + 会话 id cookie 足够了。
 */

// ── UA pool ───────────────────────────────────────────────────────────────────

interface UAVariant {
  ua: string
  secChUa: string
  secChUaPlatform: string
}

function chromeVariants(platform: NodeJS.Platform): UAVariant[] {
  // 几个较新的 Chrome 大版本。secChUa 必须与 UA 的大版本一致 —— 指纹工具会把 (UA, secChUa)
  // 这一对拿去哈希,不一致比不发还可疑。
  const versions = [119, 120, 121, 122, 123]
  if (platform === 'win32') {
    return versions.map((v) => ({
      ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
      secChUa: `"Not.A/Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`,
      secChUaPlatform: '"Windows"',
    }))
  }
  // darwin / linux / 其他一律用 macOS 的 UA(Linux 桌面客户端太少见,报 Linux 反而不自然)。
  return versions.map((v) => ({
    ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    secChUa: `"Not.A/Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`,
    secChUaPlatform: '"macOS"',
  }))
}

function pickRandomVariant(): UAVariant {
  const pool = chromeVariants(process.platform)
  return pool[Math.floor(Math.random() * pool.length)]
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BrowserSessionOptions {
  /** 裸主机名(如 'bgm.tv'),用作 Host 头。 */
  host: string
  /** 站点 Origin,用作默认 Referer。 */
  baseUrl: string
  /** 默认的 `Accept`。JSON 接口和 HTML 页面需要的值不同,由调用方逐次覆盖。 */
  accept?: string
  /** 默认 Accept-Language。 */
  acceptLanguage?: string
  /** Default sec-fetch-site. */
  secFetchSite?: 'same-origin' | 'same-site' | 'cross-site' | 'none'
  /** Default sec-fetch-mode. */
  secFetchMode?: 'cors' | 'navigate' | 'no-cors' | 'same-origin' | 'websocket'
  /** Default sec-fetch-dest. */
  secFetchDest?: 'empty' | 'document' | 'image' | 'script' | 'style' | 'font'
}

export class BrowserSession {
  private readonly variant: UAVariant = pickRandomVariant()
  private readonly cookies = new Map<string, string>()
  private readonly opts: Required<BrowserSessionOptions>

  constructor(opts: BrowserSessionOptions) {
    this.opts = {
      accept: '*/*',
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      secFetchSite: 'same-origin',
      secFetchMode: 'cors',
      secFetchDest: 'empty',
      ...opts,
    }
  }

  /** Currently chosen UA string. */
  get userAgent(): string {
    return this.variant.ua
  }

  /**
   * 构造请求头。`extra` 覆盖同名默认值 —— 导航式请求常传 Accept / sec-fetch-*,
   * POST 常传 Origin / Content-Type。
   */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'Host': this.opts.host,
      'Connection': 'keep-alive',
      'sec-ch-ua': this.variant.secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': this.variant.secChUaPlatform,
      'User-Agent': this.variant.ua,
      'Accept': this.opts.accept,
      'Accept-Language': this.opts.acceptLanguage,
      'Accept-Encoding': 'gzip, deflate, br',
      'sec-fetch-site': this.opts.secFetchSite,
      'sec-fetch-mode': this.opts.secFetchMode,
      'sec-fetch-dest': this.opts.secFetchDest,
      'Referer': this.opts.baseUrl + '/',
      ...extra,
    }
    const c = this.cookieHeader()
    if (c) h['Cookie'] = c
    return h
  }

  /**
   * 把响应的 Set-Cookie 收进罐子。只保留 name=value,属性(Path / Expires / Secure)一律忽略。
   */
  ingestSetCookie(headers: { 'set-cookie'?: string[] | string }): void {
    const raw = headers['set-cookie']
    if (!raw) return
    const arr = Array.isArray(raw) ? raw : [raw]
    for (const line of arr) {
      const semi = line.indexOf(';')
      const kv = (semi >= 0 ? line.slice(0, semi) : line).trim()
      const eq = kv.indexOf('=')
      if (eq <= 0) continue
      const name = kv.slice(0, eq).trim()
      const val = kv.slice(eq + 1).trim()
      if (name) this.cookies.set(name, val)
    }
  }

  /** Render the current cookie jar as a Cookie header value, or undefined. */
  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }
}
