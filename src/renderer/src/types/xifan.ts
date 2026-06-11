export interface XifanSearchResult {
  title: string
  cover: string
  episode: string
  year: string
  area: string
  watch_url: string
  detail_url: string
}

interface XifanSource {
  idx: number
  name: string
  template: string | null
  ep1: string | null
  /** 该源播放页 URL 模板({ep} 占位),模板拼出的链接 404 时(如 OVA 集)回源解析真实地址用。 */
  epPage: string
}

export interface XifanWatchInfo {
  title: string
  id: string
  total: number
  sources: XifanSource[]
  error?: string
}
