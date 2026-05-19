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
  /**
   * BGM 主类目数字：1=书籍 / 2=动画 / 3=音乐 / 4=游戏 / 6=三次元。
   * 用来配合 platform 推导 AnimeTrack.subjectType（anime / manga / novel / other）。
   * 光看 platform 不够 —— 动画的 platform 有 TV/剧场版/OVA 等多种字符串值,
   * 加 type 后判断更稳健。
   */
  type: number
  title: string
  title_cn: string
  summary: string
  cover: string
  link: string
  score: number
  rank: number
  votes: number
  date: string
  /**
   * BGM 子类型字符串：
   *   - 动画 (type=2): "TV" / "剧场版" / "OVA" / "WEB" / "动画" 等
   *   - 书籍 (type=1): "漫画" / "小说" / "画集" / "其他"
   *   - 其他类目：自有规则
   */
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
