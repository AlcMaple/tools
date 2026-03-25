export interface XifanSearchResult {
  title: string
  cover: string
  episode: string
  year: string
  area: string
  watch_url: string
  detail_url: string
}

export interface XifanSource {
  idx: number
  name: string
  template: string | null
  ep1: string | null
}

export interface XifanWatchInfo {
  title: string
  id: string
  total: number
  sources: XifanSource[]
  error?: string
}
