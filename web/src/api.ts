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

export async function fetchCalendar(force = false): Promise<CalendarResult> {
  const res = await fetch(`/api/calendar${force ? '?force=1' : ''}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<CalendarResult>
}
