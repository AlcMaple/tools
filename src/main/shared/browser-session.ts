/**
 * Per-site browser-like HTTP session: UA pool, cookie jar, header builder.
 *
 * Each BrowserSession instance is bound to ONE host and maintains its own
 * cookie jar. Different sites get different instances — cookies don't leak
 * between hosts, and per-site UAs stay independently random.
 *
 * Anti-detection posture:
 *   - UA + sec-ch-ua + sec-ch-ua-platform are aligned to the *same* Chrome
 *     major version, picked randomly when the session is constructed, and
 *     fixed for the rest of the app lifetime (real browsers don't swap UA
 *     mid-session).
 *   - sec-fetch-* values default to a "same-origin XHR/fetch" posture, but
 *     callers can override per-request for navigation-style requests
 *     (e.g. an HTML page GET wants `mode: navigate, dest: document`).
 *   - Cookie jar captures Set-Cookie name=value pairs and replays them via
 *     the Cookie header. Cookie attributes (Path / Expires / Secure) are
 *     ignored — sufficient for the typical analytics + session-id cookies
 *     scraped sites set.
 */

// ── UA pool ───────────────────────────────────────────────────────────────────

interface UAVariant {
  ua: string
  secChUa: string
  secChUaPlatform: string
}

function chromeVariants(platform: NodeJS.Platform): UAVariant[] {
  // Five recent Chrome majors. `secChUa` is kept aligned with the UA's major
  // — fingerprinting tools that hash the (UA, secChUa) pair want them
  // internally consistent.
  const versions = [119, 120, 121, 122, 123]
  if (platform === 'win32') {
    return versions.map((v) => ({
      ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
      secChUa: `"Not.A/Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`,
      secChUaPlatform: '"Windows"',
    }))
  }
  // darwin / linux / others → macOS UA (Linux desktop Electron clients are rare
  // enough that this looks more authentic than a Linux UA).
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
  /** Bare host (e.g. 'bgm.tv' or 'www.aowu.tv'). Used as the `Host` header. */
  host: string
  /** Origin URL (e.g. 'https://bgm.tv'). Used as default Referer. */
  baseUrl: string
  /**
   * Default `Accept` value. Override per-request when needed (e.g. JSON APIs
   * want `application/json, text/plain, *_/_*`; HTML pages want a full
   * text/html accept string). Underscores in the example are placeholders —
   * the literal value should use the standard star-slash-star wildcard.
   */
  accept?: string
  /** Default Accept-Language. */
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
   * Build the request header map. `extra` overrides any default field —
   * callers commonly pass `{ Accept, sec-fetch-* }` for navigation requests
   * and `{ Origin, Content-Type, Content-Length }` for POSTs.
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
   * Ingest Set-Cookie headers from a response. Captures only name=value;
   * attributes (Path / Expires / Secure / SameSite) are ignored.
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
