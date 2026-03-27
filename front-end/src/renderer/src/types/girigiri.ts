export interface GirigiriSearchResult {
  title: string
  cover: string
  year: string
  region: string
  play_url: string
}

export interface GirigiriEpisode {
  idx: number
  name: string
  url: string
}

export interface GirigiriWatchInfo {
  title: string
  episodes: GirigiriEpisode[]
  error?: string
}
