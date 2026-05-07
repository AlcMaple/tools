export interface AowuSearchResult {
  title: string
  cover: string
  year: string         // empty in new FantasyKon layout (only on detail page)
  area: string         // empty in new FantasyKon layout (only on detail page)
  watch_url: string    // /v/{anime_token} URL
}

export interface AowuEpisode {
  idx: number     // ep number (1, 2, ...)
  label: string   // display label e.g. "第01话", "BD", "OVA"
}

export interface AowuSource {
  idx: number     // FantasyKon's opaque source_id (e.g. 4116) — used as #s={idx} in /w/...
  name: string    // human label e.g. "D线"
  episodes: AowuEpisode[]
}

export interface AowuWatchInfo {
  id: string                   // anime token (e.g. "_2jACJ3_AIQE")
  title: string
  sources: AowuSource[]
  error?: string
}
