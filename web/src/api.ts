// 前端与后端 server/bgm/calendar.ts 的返回结构对应。网页版前端不共享后端代码（后端有
// undici 等 Node 依赖，不能进浏览器包），这里独立声明一份同形状类型。
export interface CalendarItem {
  id: number
  name: string
  name_cn: string
  url: string
  cover: string
  airDate: string
  episodes: number
  score: number
}

export interface CalendarWeekday {
  id: number
  label: string
  items: CalendarItem[]
}

export interface CalendarResult {
  data: CalendarWeekday[]
  updatedAt: number
  fromCache: boolean
}

// 只有 BGM 的 lain 图床走后端代理。手动条目允许填写其他图床 URL，不能把它们也
// 剥掉 host 后冒充 lain 路径（/files、/resource/news… 在 lain 上必然 403）。
//
// 本地上传的封面在库里存的就是一条同源相对路径（/api/tracks/<id>/cover-file，见
// server/tracks.ts），不是绝对 URL —— `new URL()` 会直接抛，得在那之前放行。
export function coverUrl(raw: string): string {
  if (raw.startsWith('/api/tracks/') && raw.endsWith('/cover-file')) return raw
  try {
    const url = new URL(raw)
    if (url.username || url.password) return ''
    if (url.hostname === 'lain.bgm.tv') return `/api/cover${url.pathname}`
    if (url.protocol === 'http:') url.protocol = 'https:'
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

export async function fetchCalendar(force = false): Promise<CalendarResult> {
  const res = await fetch(`/api/calendar${force ? '?force=1' : ''}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<CalendarResult>
}

// ── 追番 ───────────────────────────────────────────────────────────────────────
export type TrackStatus = 'watching' | 'plan' | 'done'

export interface Track {
  bgmId: number
  status: TrackStatus
  episode: number
  /** null = 连载中（跟 app 的 totalEpisodes 同语义），**不是** 0 */
  totalEpisodes: number | null
  title: string
  titleCn: string
  cover: string
  airWeekday: number
  airDate: string
  score: number
  /** 来自 BGM，加追番时锁定，不可编辑 */
  bgmTags: string[]
  userTags: string[]
  aliases: string[]
  updatedAt: number
}

/** 写入用的 patch —— **只带要改的字段**；没带的字段服务端保持沉默、原样不动（沉默 ≠ 置空） */
export type TrackPatch = Partial<
  Pick<Track, 'status' | 'episode' | 'totalEpisodes' | 'userTags' | 'title' | 'titleCn' | 'cover' | 'airWeekday' | 'airDate' | 'score'>
>

interface TrackWriteOptions {
  /** 服务端在线搜索签发的候选凭证；仅用于把成功新增的条目晋升到共享补充库。 */
  searchAdditionToken?: string
}

export interface TracksSnapshot {
  rev: number
  data: Track[]
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function fetchTracks(): Promise<TracksSnapshot> {
  // 401 必须作为读取失败抛出。把「会话失效」解释成空列表会用空数据覆盖本地缓存，
  // 用户重新登录后首屏也会误以为自己从未追过番。
  const snapshot = await json<TracksSnapshot>(await fetch('/api/tracks'))
  if (!Number.isSafeInteger(snapshot.rev) || snapshot.rev < 0 || !Array.isArray(snapshot.data)) {
    throw new Error('追番数据响应无效')
  }
  return snapshot
}

export async function fetchTracksRevision(): Promise<number> {
  const { rev } = await json<{ rev: number }>(await fetch('/api/tracks/revision'))
  if (!Number.isSafeInteger(rev) || rev < 0) throw new Error('追番数据版本无效')
  return rev
}

export async function putTrack(bgmId: number, patch: TrackPatch, options: TrackWriteOptions = {}): Promise<Track> {
  const res = await fetch(`/api/tracks/${bgmId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options.searchAdditionToken
      ? { ...patch, searchAdditionToken: options.searchAdditionToken }
      : patch),
  })
  return json<Track>(res)
}

export async function deleteTrack(bgmId: number): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`/api/tracks/${bgmId}`, { method: 'DELETE' }))
}

/** 本地图片上传封面（PNG/JPEG/WebP/GIF，≤4MB，见 server/tracks.ts 的校验）。 */
export async function uploadTrackCover(bgmId: number, file: File): Promise<Track> {
  const form = new FormData()
  form.set('file', file)
  const res = await fetch(`/api/tracks/${bgmId}/cover`, { method: 'POST', body: form })
  return json<Track>(res)
}

// ── 稀饭在线观看：定位 / 绑定 ───────────────────────────────────────────────────
// bgmId 和稀饭 animeId 是两套 id，唯一联系是标题。首次「继续看」拿追番标题去稀饭周表（免验证码）比中文名
// 匹配出候选，用户点一个确认（建绑定）→ 落库，之后直接命中。详见 server/xifan/locate.ts。
export interface XifanCandidate {
  xifanId: number
  xifanName: string
  day: number
  remarks: string // 如 "03|周一21:30"，更新到第几集
  score: number
}
export interface XifanBinding {
  xifanId: number
  xifanName: string
}

export interface XifanSearchHit {
  xifanId: number
  xifanName: string
  cover: string
  episode: string
  year: string
  area: string
}

export type XifanSearchResponse =
  | { needsCaptcha: true }
  | { needsCaptcha: false; data: XifanSearchHit[] }

export interface XifanAuthStatus {
  loggedIn: boolean
}

export const XIFAN_AUTH_EVENT_KEY = 'mapletools-xifan-auth-changed'
export const XIFAN_CAPTCHA_EVENT_KEY = 'mapletools-xifan-captcha-changed'

function signalXifanEvent(key: string): void {
  try { localStorage.setItem(key, `${Date.now()}:${Math.random()}`) } catch { /* 隐私模式禁用存储时仅失去跨标签通知 */ }
}

export function signalXifanAuthChanged(): void {
  signalXifanEvent(XIFAN_AUTH_EVENT_KEY)
}

export async function fetchXifanAuthStatus(): Promise<XifanAuthStatus> {
  return json<XifanAuthStatus>(await fetch('/api/xifan/auth/status'))
}

export async function loginXifanAccount(
  username: string,
  password: string,
  verify: string,
): Promise<void> {
  const result = await json<{ success: boolean; message: string }>(await fetch('/api/xifan/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, verify }),
  }))
  if (!result.success) throw new Error(result.message)
  signalXifanAuthChanged()
}

export async function logoutXifanAccount(): Promise<void> {
  await json<XifanAuthStatus>(await fetch('/api/xifan/auth/logout', { method: 'POST' }))
  signalXifanAuthChanged()
}

/** 追番页加载时一次拿齐当前用户的绑定 —— 绑过的「继续看」直接渲染成链接，无需再定位。 */
export async function fetchXifanBindings(): Promise<Record<number, XifanBinding>> {
  const res = await fetch('/api/xifan/bindings')
  if (!res.ok) return {}
  return (await json<{ data: Record<number, XifanBinding> }>(res)).data
}

export async function locateXifan(
  bgmId: number,
  titles: string[]
): Promise<{ bound?: XifanCandidate; candidates: XifanCandidate[] }> {
  return json(
    await fetch('/api/xifan/locate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bgmId, titles }),
    })
  )
}

export async function bindXifan(bgmId: number, xifanId: number, xifanName: string): Promise<void> {
  await json<{ ok: boolean }>(await fetch('/api/xifan/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bgmId, xifanId, xifanName }),
  }))
}

/** 搜索非周历资源。没有通过验证码时只回 needsCaptcha，不把站点验证码页当成空结果。 */
export async function searchXifan(keyword: string): Promise<XifanSearchResponse> {
  return json<XifanSearchResponse>(await fetch('/api/xifan/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword }),
  }))
}

export async function fetchXifanCaptcha(): Promise<{ imageB64: string; mime: string }> {
  // 稀饭每次取图都会替换服务端会话里的验证码；先通知其他标签作废旧图，避免网络较慢时
  // 两张图都短暂显示为“可提交”。当前标签不会收到自己的 storage 事件。
  signalXifanEvent(XIFAN_CAPTCHA_EVENT_KEY)
  return json<{ imageB64: string; mime: string }>(await fetch('/api/xifan/captcha'))
}

export async function verifyXifanCaptcha(code: string): Promise<{ success: boolean }> {
  return json<{ success: boolean }>(await fetch('/api/xifan/captcha/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }))
}

/** 播放页地址 —— bgmId 让裸 HTML 播放器能分别读取两站绑定并保持跨源切换。 */
export function playPageUrl(xifanId: number, ep: number, bgmId?: number): string {
  const query = new URLSearchParams({ animeId: String(xifanId), ep: String(ep) })
  if (bgmId != null) query.set('bgmId', String(bgmId))
  return `/api/xifan/play-page?${query.toString()}`
}

// ── Girigiri 在线观看：与稀饭分开保存绑定，不能把两个站点的编号互相推断 ────────
export interface GirigiriCandidate {
  girigiriId: string
  girigiriName: string
  day: number
  remarks: string
  score: number
}

export interface GirigiriBinding {
  girigiriId: string
  girigiriName: string
}

export interface GirigiriSearchHit {
  girigiriId: string
  girigiriName: string
  cover: string
  episode: string
  year: string
  area: string
}

export type GirigiriSearchResponse =
  | { needsCaptcha: true }
  | { needsCaptcha: false; data: GirigiriSearchHit[] }

export async function fetchGirigiriBindings(): Promise<Record<number, GirigiriBinding>> {
  const res = await fetch('/api/girigiri/bindings')
  if (!res.ok) return {}
  return (await json<{ data: Record<number, GirigiriBinding> }>(res)).data
}

export async function locateGirigiri(
  bgmId: number,
  titles: string[],
): Promise<{ bound?: GirigiriCandidate; candidates: GirigiriCandidate[] }> {
  return json(await fetch('/api/girigiri/locate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bgmId, titles }),
  }))
}

export async function bindGirigiri(bgmId: number, girigiriId: string, girigiriName: string): Promise<void> {
  await json<{ ok: boolean }>(await fetch('/api/girigiri/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bgmId, girigiriId, girigiriName }),
  }))
}

export async function searchGirigiri(keyword: string): Promise<GirigiriSearchResponse> {
  return json<GirigiriSearchResponse>(await fetch('/api/girigiri/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword }),
  }))
}

export async function fetchGirigiriCaptcha(): Promise<{ imageB64: string; mime: string }> {
  return json<{ imageB64: string; mime: string }>(await fetch('/api/girigiri/captcha'))
}

export async function verifyGirigiriCaptcha(code: string): Promise<{ success: boolean }> {
  return json<{ success: boolean }>(await fetch('/api/girigiri/captcha/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }))
}

export function girigiriPlayPageUrl(girigiriId: string, ep: number, bgmId?: number): string {
  const query = new URLSearchParams({ animeId: girigiriId, ep: String(ep) })
  if (bgmId != null) query.set('bgmId', String(bgmId))
  return `/api/girigiri/play-page?${query.toString()}`
}

// ── 加番搜索（打本地 BGM 动漫索引，见 server/bgm/anime-index.ts）───────────────
export interface AnimeHit {
  bgmId: number
  name: string // 日文原名
  nameCn: string // 中文译名
  date: string // 放送日期
  score: number
  /** 只在 BGM 在线候选上存在；加番成功后由服务端验签，客户端不能自行构造共享数据。 */
  searchAdditionToken?: string
}

export interface SearchResult {
  ready: boolean // false = 服务器还没生成索引（没跑同步脚本）
  data: AnimeHit[]
  total?: number // 索引收录条数
  builtAt?: number // 索引生成时间（ms）—— 太久没更新说明每周的同步挂了，前端会提示
  /** local = 离线索引；learned = 已成功加过的共享补充；online = BGM 在线结果 */
  source?: 'local' | 'learned' | 'online'
  /** 在线补充没成的具体原因（限流 / 超时 / 冷却中），如实显示，不糊成「网络错误」 */
  onlineError?: string
}

/** 搜索动漫加追番。 */
export async function searchAnime(q: string): Promise<SearchResult> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
  if (!res.ok) return { ready: true, data: [] }
  return res.json() as Promise<SearchResult>
}
