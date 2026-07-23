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

// 封面走后端代理 —— BGM 图床国内被墙，浏览器不能直连（见 server/index.ts 的 /api/cover）。
// 路径式：`https://lain.bgm.tv/pic/...` → `/api/cover/pic/...`，URL 里不出现 bgm.tv，避免 HTTP
// 明文下被 GFW 关键字 RST。
export function coverUrl(raw: string): string {
  const m = raw.match(/^https?:\/\/[^/]+(\/.*)$/)
  return m ? `/api/cover${m[1]}` : ''
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
  Pick<Track, 'status' | 'episode' | 'totalEpisodes' | 'userTags' | 'title' | 'titleCn' | 'cover' | 'airWeekday' | 'score'>
>

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function fetchTracks(): Promise<Track[]> {
  const res = await fetch('/api/tracks')
  if (res.status === 401) return [] // 未登录 —— 页面自己会提示，不当异常抛
  return (await json<{ data: Track[] }>(res)).data
}

export async function putTrack(bgmId: number, patch: TrackPatch): Promise<Track> {
  const res = await fetch(`/api/tracks/${bgmId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return json<Track>(res)
}

export async function deleteTrack(bgmId: number): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`/api/tracks/${bgmId}`, { method: 'DELETE' }))
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
  await fetch('/api/xifan/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bgmId, xifanId, xifanName }),
  })
}

/** 播放页地址 —— 服务端返回的裸 HTML 播放器，新标签打开。 */
export function playPageUrl(xifanId: number, ep: number): string {
  return `/api/xifan/play-page?animeId=${xifanId}&ep=${ep}`
}

// ── 加番搜索（打本地 BGM 动漫索引，见 server/bgm/anime-index.ts）───────────────
export interface AnimeHit {
  bgmId: number
  name: string // 日文原名
  nameCn: string // 中文译名
  date: string // 放送日期
  score: number
}

export interface SearchResult {
  ready: boolean // false = 服务器还没生成索引（没跑同步脚本）
  data: AnimeHit[]
  total?: number // 索引收录条数
  builtAt?: number // 索引生成时间（ms）—— 太久没更新说明每周的同步挂了，前端会提示
  /** local = 本地索引命中；online = 本地一条都没有，退回 BGM 在线搜的结果 */
  source?: 'local' | 'online'
  /** 在线补充没成的具体原因（限流 / 超时 / 冷却中），如实显示，不糊成「网络错误」 */
  onlineError?: string
}

/** 搜索动漫加追番。 */
export async function searchAnime(q: string): Promise<SearchResult> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
  if (!res.ok) return { ready: true, data: [] }
  return res.json() as Promise<SearchResult>
}
