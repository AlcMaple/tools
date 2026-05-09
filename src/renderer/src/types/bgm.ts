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
