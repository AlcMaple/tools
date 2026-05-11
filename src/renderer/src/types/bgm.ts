export interface BgmSearchResult {
  title: string
  date: string
  rate: string
  link: string
}

interface BgmStaff {
  role: string
  name: string
  name_cn: string
}

export interface BgmDetail {
  id: number
  title: string
  title_cn: string
  summary: string
  cover: string
  link: string
  score: number
  rank: number
  votes: number
  date: string
  platform: string
  episodes: number
  tags: string[]
  studio: string
  staff: BgmStaff[]
  infobox: Record<string, string>
}

// ── Weekly calendar (本季新番) ─────────────────────────────────────────────────

export interface BgmCalendarItem {
  id: number
  name: string
  name_cn: string
  url: string
  cover: string
  airDate: string
  episodes: number
  score: number
}

export interface BgmCalendarWeekday {
  /** 1=Mon … 7=Sun (BGM's convention). */
  id: number
  label: string
  items: BgmCalendarItem[]
}

export interface BgmCalendarResult {
  data: BgmCalendarWeekday[]
  /** ms epoch when this snapshot was fetched. */
  updatedAt: number
  /** Whether the result came from disk cache. */
  fromCache: boolean
}
