export interface AowuSearchResult {
  title: string
  cover: string
  year: string
  area: string
  watch_url: string
}

export interface AowuEpisode {
  idx: number     // used in /play/{id}-{src}-{idx}/
  label: string   // display label e.g. "01", "BD", "OVA"
}

export interface AowuSource {
  idx: number
  name: string
  episodes: AowuEpisode[]
}

export interface AowuWatchInfo {
  id: string
  title: string
  sources: AowuSource[]
  error?: string
}
