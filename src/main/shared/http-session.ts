/**
 * Cookie-aware HTTP session using Node.js built-in https/http.
 * Avoids undici/axios entirely (no browser globals required).
 */
import * as https from 'https'
import * as http from 'http'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { IncomingMessage } from 'http'
import { app } from 'electron'

export interface HttpResponse {
  status: number
  body: string
  bodyBuffer: Buffer
}

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

  private updateFromSetCookie(headers: IncomingMessage['headers']): void {
    const sc = headers['set-cookie']
    const list = Array.isArray(sc) ? sc : sc ? [sc] : []
    for (const s of list) {
      const part = s.split(';')[0].trim()
      const eq = part.indexOf('=')
      if (eq > 0) this.cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  }

  async get(url: string, extraHeaders: Record<string, string> = {}): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      this._doGet(url, extraHeaders, 5, resolve, reject)
    })
  }

  private _doGet(
    url: string,
    extraHeaders: Record<string, string>,
    redirectsLeft: number,
    resolve: (r: HttpResponse) => void,
    reject: (e: Error) => void
  ): void {
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https
    const headers = {
      ...this.baseHeaders,
      Cookie: this.getCookieString(),
      ...extraHeaders,
    }
    const options = {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port) : undefined,
      path: u.pathname + u.search,
      headers,
      rejectUnauthorized: false,
    }
    const req = mod.get(options, (res) => {
      this.updateFromSetCookie(res.headers)
      if (
        res.statusCode &&
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        res.resume()
        if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return }
        const next = new URL(res.headers.location, url).href
        this._doGet(next, extraHeaders, redirectsLeft - 1, resolve, reject)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ status: res.statusCode ?? 0, body: buf.toString('utf-8'), bodyBuffer: buf })
      })
      res.on('error', reject)
    })
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)) })
    req.on('error', reject)
  }
}
