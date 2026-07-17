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
