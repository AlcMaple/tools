// 协议取自 2026-09-28 新站公开页面与浏览器请求；两端共用解析，传输和凭据存储仍各自隔离。
export const NEXT_ORIGIN = 'https://next.xifanacg.com'
export const NEXT_API = 'https://api.xifanacg.com'
export const NEXT_PUBLIC_KEY = 'sb_publishable_OBIVAWACIX6lPXrO98_z24_HcsmalkA'
const AUTH_COOKIE = 'sb-rzmsnqblptbceicadbyd-auth-token'

export interface NextAuth {
  access_token: string
  refresh_token: string
  expires_at: number
}
export interface NextResponse { status: number; body: string; retryAfter?: string }
export type NextTransport = (url: string, method: 'GET' | 'POST', headers: Record<string, string>, body?: string, signal?: AbortSignal) => Promise<NextResponse>
export interface NextEpisode { id: number; number: number; title: string; kind: string }
export interface NextSource { id: number; code: string; name: string; episodes: NextEpisode[] }
export interface NextDetail { id: number; title: string; sources: NextSource[] }
export interface NextHit { id: number; title: string; cover: string; episode: string; year: string; area: string }
export class NextError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502, readonly retryAfter: number | null = null) {
    super(message)
  }
}
export function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}
const string = (v: unknown): string => typeof v === 'string' ? v : ''
export function parseNextAuth(v: unknown): NextAuth | null {
  const o = record(v)
  return typeof o.access_token === 'string' && o.access_token.length > 0 && typeof o.refresh_token === 'string' && o.refresh_token.length > 0 && typeof o.expires_at === 'number' && Number.isFinite(o.expires_at)
    ? { access_token: o.access_token, refresh_token: o.refresh_token, expires_at: o.expires_at } : null
}

// 只解析内嵌 JSON，绝不执行源站 script。Flight 的多个分片先合并，避免大详情被截在字符串中间。
export function flightObjects(html: string): Record<string, unknown>[] {
  let stream = ''
  for (const m of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
    const chunk: unknown = JSON.parse(m[1])
    if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === 'string') stream += chunk[1]
  }
  const objects: Record<string, unknown>[] = []
  function walk(v: unknown): void {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (!v || typeof v !== 'object') return
    const o = record(v)
    objects.push(o)
    Object.values(o).forEach(walk)
  }
  for (const line of stream.split('\n')) {
    const payload = line.slice(line.indexOf(':') + 1)
    if (!payload.startsWith('[') && !payload.startsWith('{')) continue
    try { walk(JSON.parse(payload)) } catch { /* Flight 的资源引用不是 JSON 数据行。 */ }
  }
  return objects
}
export function parseNextDetail(html: string, expectedId: number): NextDetail {
  const data = flightObjects(html).find(o => record(o.anime).id === expectedId && Array.isArray(o.sources))
  if (!data) throw new NextError('DETAIL_UNAVAILABLE', '稀饭番剧详情未返回可用选集，请到源站确认资源及账号权限')
  const episodeNumbers = new Map<number, number>()
  const extras: number[] = []
  let maximum = 0
  for (const raw of data.sources as unknown[]) {
    const episodes = record(raw).episodes
    if (!Array.isArray(episodes)) continue
    for (const rawEpisode of episodes) {
      const e = record(rawEpisode)
      if (!Number.isSafeInteger(e.id) || Number(e.id) < 1) throw new Error('稀饭剧集 ID 无效')
      if (e.kind === 'main' && Number.isSafeInteger(e.episode_number) && Number(e.episode_number) > 0) {
        episodeNumbers.set(Number(e.id), Number(e.episode_number))
        maximum = Math.max(maximum, Number(e.episode_number))
      } else if (!extras.includes(Number(e.id))) extras.push(Number(e.id))
    }
  }
  for (const id of extras) if (!episodeNumbers.has(id)) episodeNumbers.set(id, ++maximum)
  const sources: NextSource[] = []
  for (const raw of data.sources as unknown[]) {
    const s = record(raw)
    if (!Number.isSafeInteger(s.id) || typeof s.code !== 'string' || !Array.isArray(s.episodes)) continue
    const episodes = s.episodes.map((raw, index): NextEpisode => {
      const e = record(raw)
      if (!Number.isSafeInteger(e.id) || Number(e.id) < 1) throw new Error('稀饭剧集 ID 无效')
      return { id: Number(e.id), number: episodeNumbers.get(Number(e.id))!, title: string(e.title) || `第 ${e.episode_number ?? index + 1} 集`, kind: string(e.kind) }
    })
    sources.push({ id: Number(s.id), code: s.code, name: string(s.name) || s.code, episodes })
  }
  return { id: expectedId, title: string(record(data.anime).title), sources }
}
export function nextPage(detail: NextDetail, ep: number, sourceId?: number): string {
  const source = sourceId === undefined ? detail.sources[0] : detail.sources.find(s => s.id === sourceId)
  const episode = source?.episodes.find(e => e.number === ep)
  if (!source || !episode) throw new NextError('not_found', '稀饭这条线路尚未提供该集', 404)
  return `${NEXT_ORIGIN}/anime/${detail.id}/play/${episode.id}?source=${encodeURIComponent(source.code)}`
}
export function nextAnimeId(url: string): number {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !(u.hostname === 'xifanacg.com' || u.hostname.endsWith('.xifanacg.com'))) throw new Error('稀饭页面地址无效')
  if (u.hostname !== 'next.xifanacg.com' || !u.pathname.startsWith('/anime/')) throw new Error('稀饭已更换番剧编号，请在新站重新搜索并确认条目')
  const id = Number(u.pathname.match(/^\/anime\/(\d+)(?:\/|$)/)?.[1])
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('稀饭番剧 ID 无效')
  return id
}

export class NextClient {
  private revision = 0
  private controller = new AbortController()
  private refreshing: Promise<NextAuth | null> | null = null
  private details = new Map<number, { at: number; value: NextDetail }>()
  private detailInflight = new Map<number, Promise<NextDetail>>()
  constructor(private transport: NextTransport, private readAuth: () => Promise<NextAuth | null>, private saveAuth: (auth: NextAuth | null) => Promise<void>) {}

  private async request(url: string, method: 'GET' | 'POST', body: unknown, auth: NextAuth | null): Promise<NextResponse> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
    const origin = new URL(url).origin
    if (origin === NEXT_API) {
      headers.apikey = NEXT_PUBLIC_KEY
      if (auth) headers.Authorization = `Bearer ${auth.access_token}`
    } else if (origin === NEXT_ORIGIN) {
      headers.Accept = 'text/html'
      if (auth) {
        const value = `base64-${Buffer.from(JSON.stringify(auth)).toString('base64url')}`
        const pieces = value.match(/.{1,3000}/g) ?? []
        headers.Cookie = pieces.map((p, i) => `${AUTH_COOKIE}${pieces.length > 1 ? `.${i}` : ''}=${p}`).join('; ')
      }
    } else throw new Error('稀饭请求域名无效')
    const owner = this.controller
    const response = await this.transport(url, method, headers, body === undefined ? undefined : JSON.stringify(body), owner.signal)
    if (owner.signal.aborted) throw new Error('稀饭登录状态已改变，请重新操作')
    return response
  }
  private decode(res: NextResponse): unknown {
    let data: unknown
    try { data = JSON.parse(res.body) } catch {
      throw new NextError('INVALID_RESPONSE', `稀饭返回了非 JSON 响应（HTTP ${res.status}）`, res.status)
    }
    const o = record(data)
    if (res.status < 200 || res.status >= 300 || o.ok === false) {
      const code = string(o.error_code) || string(o.code) || string(o.error) || `HTTP_${res.status}`
      const messages: Record<string, string> = {
        invalid_credentials: '稀饭邮箱或密码错误', email_not_confirmed: '请先验证稀饭账号邮箱',
        unauthorized: '请先登录稀饭账号', unauthenticated: '请先登录稀饭账号',
        forbidden: '当前稀饭账号没有该资源的观看权限，请到源站查看要求',
        not_found: '稀饭这条线路尚未提供该集', rate_limited: '稀饭请求过于频繁，请稍后再试',
        playback_service_unavailable: '稀饭播放服务暂时不可用',
      }
      const retry = Number(o.retry_after ?? res.retryAfter)
      throw new NextError(code, messages[code] || string(o.message) || string(o.msg) || `稀饭请求失败：${code}`, res.status, Number.isFinite(retry) ? retry : null)
    }
    return data
  }
  private invalidate(): void { this.controller.abort(); this.controller = new AbortController(); this.revision++; this.details.clear(); this.detailInflight.clear() }
  async auth(): Promise<NextAuth | null> {
    const auth = await this.readAuth()
    if (!auth || auth.expires_at > Date.now() / 1000 + 30) return auth
    if (this.refreshing) return this.refreshing
    const revision = this.revision
    const pending = (async () => {
      const response = await this.request(`${NEXT_API}/auth/v1/token?grant_type=refresh_token`, 'POST', { refresh_token: auth.refresh_token }, null)
      if ([400, 401, 403].includes(response.status)) {
        if (revision === this.revision) { this.invalidate(); await this.saveAuth(null) }
        throw new NextError('unauthorized', '稀饭登录已过期，请重新登录', 401)
      }
      const next = parseNextAuth(this.decode(response))
      if (!next) throw new Error('稀饭未返回有效登录会话')
      if (revision !== this.revision) throw new Error('稀饭登录状态已改变，请重新操作')
      await this.saveAuth(next)
      return next
    })()
    this.refreshing = pending
    try { return await pending } finally { if (this.refreshing === pending) this.refreshing = null }
  }
  async login(email: string, password: string): Promise<void> {
    this.invalidate()
    const revision = this.revision
    const auth = parseNextAuth(this.decode(await this.request(`${NEXT_API}/auth/v1/token?grant_type=password`, 'POST', { email, password }, null)))
    if (!auth) throw new Error('稀饭未返回有效登录会话')
    if (revision !== this.revision) throw new Error('稀饭登录状态已改变，请重新操作')
    await this.saveAuth(auth)
  }
  async status(): Promise<boolean> {
    const auth = await this.auth()
    if (!auth) return false
    const revision = this.revision
    const response = await this.request(`${NEXT_API}/auth/v1/user`, 'GET', undefined, auth)
    if (response.status === 401) {
      if (revision === this.revision) { this.invalidate(); await this.saveAuth(null) }
      return false
    }
    return typeof record(this.decode(response)).id === 'string'
  }
  async logout(): Promise<void> {
    this.invalidate()
    const revision = this.revision
    const auth = await this.readAuth()
    if (revision !== this.revision) throw new Error('稀饭登录状态已改变，请重新操作')
    await this.saveAuth(null)
    if (auth) {
      try { this.decodeLogout(await this.request(`${NEXT_API}/auth/v1/logout?scope=local`, 'POST', undefined, auth)) }
      catch (error) { console.error('[xifan:auth] 远端退出失败，本地会话已清除：', error) }
    }
  }
  private decodeLogout(res: NextResponse): void { if (res.status !== 204 && res.status !== 401) this.decode(res) }
  async search(keyword: string): Promise<NextHit[]> {
    if (!keyword.trim() || keyword.trim().length > 100) throw new Error('搜索词长度需为 1–100 个字符')
    const result: NextHit[] = []
    const auth = await this.auth()
    for (let page = 1; page <= 20; page++) {
      const raw = this.decode(await this.request(`${NEXT_API}/rest/v1/rpc/search_animes`, 'POST', { search_term: keyword.trim(), page_number: page, items_per_page: 50 }, auth))
      if (!Array.isArray(raw)) throw new Error('稀饭搜索响应格式已变化')
      for (const v of raw) {
        const row = record(v)
        if (!Number.isSafeInteger(row.id) || !string(row.title)) throw new Error('稀饭搜索条目格式异常')
        result.push({ id: Number(row.id), title: string(row.title), cover: string(row.cover_url), episode: row.current_episodes == null ? '' : `更新至 ${row.current_episodes} 集`, year: String(row.release_year ?? ''), area: string(row.region) })
      }
      if (!raw.length || result.length >= Number(record(raw[0]).total_count ?? result.length)) return result
    }
    throw new Error('稀饭搜索结果过多，请缩小搜索范围')
  }
  async detail(id: number, force = false): Promise<NextDetail> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('稀饭番剧 ID 无效')
    const auth = await this.auth()
    const hit = this.details.get(id)
    if (!force && hit && Date.now() - hit.at < 15 * 60_000) return hit.value
    const existing = this.detailInflight.get(id)
    if (existing) return existing
    const revision = this.revision
    const job = (async () => {
      const res = await this.request(`${NEXT_ORIGIN}/anime/${id}`, 'GET', undefined, auth)
      if (res.status !== 200) throw new NextError(`HTTP_${res.status}`, `稀饭详情返回 HTTP ${res.status}`, res.status)
      const value = parseNextDetail(res.body, id)
      if (revision !== this.revision) throw new Error('稀饭登录状态已改变，请重新操作')
      if (this.details.size >= 100) this.details.delete(this.details.keys().next().value as number)
      this.details.set(id, { at: Date.now(), value })
      return value
    })()
    this.detailInflight.set(id, job)
    try { return await job } finally { if (this.detailInflight.get(id) === job) this.detailInflight.delete(id) }
  }
  async playback(id: number, ep: number, sourceId: number): Promise<{ url: string; code: string; page: string }> {
    const detail = await this.detail(id)
    const source = detail.sources.find(s => s.id === sourceId)
    const episode = source?.episodes.find(e => e.number === ep)
    if (!source || !episode) throw new NextError('not_found', '稀饭这条线路尚未提供该集', 404)
    const data = record(this.decode(await this.request(`${NEXT_API}/functions/v1/issue-web-playback`, 'POST', { action: 'fallback', episode_id: episode.id, source_id: sourceId }, await this.auth())))
    if (data.episode_id !== episode.id || data.anime_id !== id) throw new Error('稀饭返回的媒体与所选番剧或集数不一致')
    const candidates = Array.isArray(data.candidates) ? data.candidates : []
    if (data.source_id !== sourceId && !candidates.some(v => record(v).source_id === sourceId && record(v).url === data.url)) throw new Error('稀饭返回的线路与所选线路不一致')
    const url = new URL(string(data.url))
    if (url.protocol !== 'https:') throw new Error('稀饭媒体地址协议无效')
    return { url: url.href, code: source.code, page: nextPage(detail, ep, sourceId) }
  }
  async schedule(): Promise<{ xifanId: number; name: string; day: number; remarks: string }[]> {
    const res = await this.request(`${NEXT_ORIGIN}/schedule`, 'GET', undefined, null)
    if (res.status !== 200) throw new NextError(`HTTP_${res.status}`, `稀饭周表返回 HTTP ${res.status}`, res.status)
    const groups = flightObjects(res.body).filter(o => typeof o.weekday === 'number' && Array.isArray(o.animes))
    if (!groups.length) throw new Error('稀饭周表数据格式已变化')
    return groups.flatMap(g => (g.animes as unknown[]).map(v => {
      const o = record(v)
      return { xifanId: Number(o.id), name: string(o.title), day: Number(g.weekday) + 1, remarks: String(o.remarks ?? `更新至 ${o.current_episodes ?? 0} 集`) }
    }))
  }
}
