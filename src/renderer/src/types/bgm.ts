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
   * BGM 主类目数字:1=书籍 / 2=动画 / 3=音乐 / 4=游戏 / 6=三次元。
   * 配合 platform 一起推导条目子类型 —— 光看 platform 不够,动画的 platform 有 TV/剧场版/OVA
   * 等多种取值,加上 type 才判得稳。
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
   * BGM 子类型字符串:动画是 "TV" / "剧场版" / "OVA" / "WEB" 等,书籍是 "漫画" / "小说" /
   * "画集" / "其他"。
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
  /** 1=周一 … 7=周日,沿用 BGM 的约定。 */
  id: number
  label: string
  items: BgmCalendarItem[]
}

export interface BgmCalendarResult {
  data: BgmCalendarWeekday[]
  /** 这份快照抓取时的时间戳(ms)。 */
  updatedAt: number
  /** 结果是否来自磁盘缓存。 */
  fromCache: boolean
}

/** BGM 鉴权状态 —— 只含布尔/时间戳，不含 token/cookie 明文（见主进程 credentials.ts）。 */
export interface BgmAuthStatus {
  /** 已配置个人访问令牌（设置里填的，存在本地 bgm_auth.json）。 */
  hasToken: boolean
  /** 已捕获网页登录 cookie（点过「登录 BGM」并成功）。 */
  loggedIn: boolean
  /** 上次登录（捕获 cookie）的时间戳 ms。 */
  cookieSavedAt?: number
}

/** 登录用邮箱/密码（供内嵌登录窗自动填充）。纯本地存储。 */
export interface BgmCredentials {
  email: string
  password: string
}
