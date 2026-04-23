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

export interface GirigiriSource {
  name: string
  episodes: GirigiriEpisode[]
}

export interface GirigiriWatchInfo {
  title: string
  sources: GirigiriSource[]
  episodes: GirigiriEpisode[]  // = sources[0].episodes
  error?: string
}
