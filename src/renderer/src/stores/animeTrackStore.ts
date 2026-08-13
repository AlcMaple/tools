// 追番记录 store —— localStorage-only,普通 class + 手动 subscribe,读时 normalize。
//
// 主键是 `bgmId`。应用里其他所有面(搜索结果、周历……)都靠每条 track 的 `bindings[]`
// 关联回来,而 binding 只在用户**亲手**挑选片源时写入 —— **不做模糊标题匹配**。

import { useEffect, useState } from 'react'
import { scheduleStorageWrite } from '../utils/deferredStorage'
import { reportError, backupCorrupt } from '../utils/reportError'
import { weekdayFromAirDate } from '../utils/airDate'

/** 观看状态。`considering`(观望,候补看看再说)与 `plan`(想看,已决定追)不同
 *  两者之间**不自动升级**,由用户手动迁。 */
export type AnimeStatus = 'plan' | 'watching' | 'completed' | 'considering'

/** MyAnime 顶部 tab 的过滤维度。`other`(画集/其他)**不出现在任何 tab**,但数据保留
 *  免得用户加了一本书之后 UI 里再也看不到。派生规则见 `deriveSubjectType()`。 */
export type SubjectType = 'anime' | 'manga' | 'novel' | 'other'

const VALID_SUBJECT_TYPE: ReadonlyArray<SubjectType> = ['anime', 'manga', 'novel', 'other']

/** 从 BGM detail 的 `type` + `platform` 推导 SubjectType;老缓存 type=0 时看 platform 兜底。 */
export function deriveSubjectType(type: number, platform: string): SubjectType {
  if (type === 2) return 'anime'
  if (type === 1) {
    if (platform === '漫画') return 'manga'
    if (platform === '小说') return 'novel'
    return 'other'
  }
  // 老 detail 缓存没有 type,只能靠 platform 字符串猜
  if (type === 0) {
    if (platform === '漫画') return 'manga'
    if (platform === '小说') return 'novel'
    // 动画的 platform 是 TV/剧场版/OVA/WEB 等,没出现「漫画/小说」就当动画
    return 'anime'
  }
  return 'other'
}

export interface AnimeBinding {
  /** 首字母大写,与 SearchDownload 的 `Source` 类型一致。 */
  source: 'Xifan' | 'Girigiri' | 'Aowu' | 'Bilibili' | 'Custom'
  /** 在该站上的标题,用户回看绑定时显示。 */
  sourceTitle: string
  /** 站内 slug/key,或整条 URL。 */
  sourceKey: string
  /** 显式 URL;没有时由调用方按各站约定从 sourceKey 拼。 */
  sourceUrl?: string
}

export interface AnimeTrack {
  bgmId: number
  /** 加追番时从 BGM detail 派生后写入,之后不再变化(除非删了重加)。老数据默认 'anime'。 */
  subjectType: SubjectType
  title: string
  titleCn?: string
  /** BGM 详情 infobox 的「别名」栏。**只给本地搜索用**(搜别名也能命中这条追番)
   *  绝不参与片源关联 —— 片源只认用户亲手挑的 `bindings[]`。 */
  aliases: string[]
  cover?: string
  status: AnimeStatus
  /** 看到第几集,0 = 还没开始。 */
  episode: number
  /** BGM 给得出就填;连载中集数待定时留 undefined。 */
  totalEpisodes?: number
  /**
   * 放送日期,决定在线观看按钮显不显示(判定见 utils/airDate.ts 的 isUnaired):
   *   - undefined = 老数据。BGM 条目宽容当已播出,**手动条目(负数 bgmId)当未定档**
   *                 —— 手动加的多是 BGM 还没收录的未播出续季。
   *   - ''        = 确认未定档 → 隐藏
   *   - 其他      = YYYY-MM-DD 或手填文本,解析出未来日期 → 隐藏
   * 不做自动复查(用户决策):未定档条目播出后靠用户编辑或删了重加解锁。
   */
  airDate?: string
  /**
   * 每周放送日:1=周一 … 7=周日。周历加番时直接记周历列,其余用首播日期的星期兜底。
   * **必须落库、不能上传时临时推导**:手动条目可能没有完整日期,但用户仍知道它周几更新
   * 网页版的「今天更新」分组要用。
   */
  airWeekday?: number
  /**
   * 小说阅读进度 —— 一级=卷 / 二级=章。**仅 subjectType==='novel' 用**；
   * 动漫 / 漫画走上面的 episode 数字模型，这俩字段保持 ''。
   *
   * 用 string 而非 number 是刻意的：默认是数字（"12" / "6"），但现实里第 12 卷
   * 之后可能是「SS2 / 短篇集」、第 6 章之后可能是「后记」，纯数字表达不了，所以
   * 允许任意文本。UI 的 +/- 步进只在当前值是纯整数时生效（非数字时禁用，让用户
   * 直接改文本框）。老 track / 非小说没这俩字段时 normalize() 默认 ''（= 未开始），
   * 零手动迁移。小说不用好看集（goodEpisodes 留空），只保留 favorite 星级。
   */
  novelVolume: string
  novelChapter: string
  /** Per-source bindings — empty in step 1a, populated in step 1b. */
  bindings: AnimeBinding[]
  notes: string[]
  /**
   * 最爱值 0-6，用户在 UI 上点🌟设级（B 站风格的星级评分）。
   * 0 = 全空，6 = 全亮（最爱）。源自原 PDF 的"最爱值"概念但简化成纯星级,
   * 不再带 +1/+2 评判逻辑（但评判标准还是给用户做参考，CriteriaModal 里有）。
   */
  favorite: number
  /**
   * 观望次数 —— 仅在 status='considering'（观望）时有意义。
   *
   * **跟 favorite 物理隔离**：观望阶段是"候补，看看再说"，跟"整体喜爱程度"
   * 的最爱值不是一个语义。原 PDF 设计里观望次数 > 3 时用户自己手动迁到在追
   * （不自动升级），UI 上 ≥4 会高亮显示"建议升到在追"提示。
   *
   * 状态切换时不重置：从观望升到在追后 observeCount 保留作为历史记录,
   * 用户哪天再切回观望 counter 接着用。其他状态下这个字段虽然在数据里,
   * 但 UI 不展示也不可编辑（避免跨状态的语义混淆）。
   */
  observeCount: number
  /**
   * BGM 题材标签。**第一次拿到内容后就锁死**(见 upsert):BGM 社区 tag 会浮动,锁住才能
   * 保证用户看到的分类不会某天自己变掉、列表不会因 tag 漂移集体 re-render、WebDAV 上
   * 是稳定快照。想更新只能删了重加。
   */
  bgmTags: string[]
  /** 用户自己加的标签,与 bgmTags 物理隔离,互不影响。 */
  userTags: string[]
  /**
   * 好看集:**具体集号的数组**(不是计数),`[1,4,5,16,17]` 渲染时由 compressGoodEpisodes()
   * 折回「1、4-5、16-17」。评判标准见 CriteriaModal。
   * 不夹到 totalEpisodes 上限 —— 总集数可能被用户改小,越界值原样留着让用户自己处理。
   */
  goodEpisodes: number[]
  /** 好看集备注,键是集号。与 goodEpisodes 平行存放;normalize 只保留仍被标记的集
   *  取消标记时备注自动剪掉,不留孤儿。 */
  goodEpisodeNotes: Record<number, string>
  /** 首次追番的日期。 */
  startedAt: string
  /** 最后一次改动的日期。 */
  updatedAt: string
}

const STORAGE_KEY = 'maple-anime-tracks-v1'
const VALID_STATUS: ReadonlyArray<AnimeStatus> = ['plan', 'watching', 'completed', 'considering']
const FAVORITE_MAX = 6
/** 每条 track 最多显示几个 BGM 标签,与 main/bgm/detail.ts 的 slice 一致。 */
const BGM_TAG_LIMIT = 4

// ── 标签数组工具 ─────────────────────────────────────────────────────────────

/** 标签数组归一:trim、去空、去重,**保留输入顺序**(BGM 那份是按热度排好的,别排序)。 */
export function normalizeTagList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of input) {
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** 从 infobox 取「别名」。主进程已把多别名拼成单串,这里按常见分隔符切回数组。 */
export function aliasesFromInfobox(infobox: Record<string, string> | undefined | null): string[] {
  if (!infobox) return []
  const raw = infobox['别名'] ?? ''
  if (!raw) return []
  return normalizeTagList(raw.split(/[、,，;；/]/))
}

// ── 好看集集号工具 ──────────────────────────────────────────────────────────

/** 好看集集号归一:去掉 ≤0 / 非整数,去重升序。normalize 和编辑弹窗共用同一套。 */
export function normalizeGoodEpisodes(input: unknown): number[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<number>()
  for (const v of input) {
    if (typeof v !== 'number') continue
    if (!Number.isFinite(v)) continue
    const n = Math.floor(v)
    if (n <= 0) continue
    seen.add(n)
  }
  return [...seen].sort((a, b) => a - b)
}

/** 备注只保留「集号仍在 eps 里 + 值非空」的项,取消标记的集其备注自然被剪掉。 */
export function normalizeGoodEpisodeNotes(input: unknown, eps: number[]): Record<number, string> {
  if (!input || typeof input !== 'object') return {}
  const allowed = new Set(eps)
  const out: Record<number, string> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const ep = Number(k)
    if (!Number.isInteger(ep) || !allowed.has(ep)) continue
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    if (trimmed) out[ep] = trimmed
  }
  return out
}

/** 集号数组压成紧凑串,连续区间合并:`[1,4,5,16,17,18,19]` → 「1、4-5、16-19」。 */
export function compressGoodEpisodes(eps: number[]): string {
  const sorted = normalizeGoodEpisodes(eps)
  if (sorted.length === 0) return ''
  const groups: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    if (cur === prev + 1) {
      prev = cur
      continue
    }
    groups.push(start === prev ? String(start) : `${start}-${prev}`)
    start = cur
    prev = cur
  }
  groups.push(start === prev ? String(start) : `${start}-${prev}`)
  return groups.join('、')
}

/**
 * 幂等归一,localStorage 读取和 WebDAV 拉取共用。丢掉没有数字 bgmId 的条目,按 bgmId
 * 去重(保留靠后的),逐条过 normalizeTrack。
 */
export function normalizeTracks(input: unknown): AnimeTrack[] {
  if (!Array.isArray(input)) return []
  const map = new Map<number, AnimeTrack>()
  for (const v of input) {
    if (!v || typeof v !== 'object') continue
    const t = v as Partial<AnimeTrack>
    if (typeof t.bgmId !== 'number') continue
    map.set(t.bgmId, normalize({ ...t, bgmId: t.bgmId }))
  }
  return [...map.values()]
}

function normalize(t: Partial<AnimeTrack> & { bgmId: number }): AnimeTrack {
  const now = new Date().toISOString()
  // 老 blob / 外部导入的数据里可能还有已删除的 paused/dropped,兜底到 plan
  const status = (t.status && VALID_STATUS.includes(t.status)) ? t.status : 'plan'
  // 老 track / 非法值一律当 anime
  const subjectType: SubjectType = (t.subjectType && VALID_SUBJECT_TYPE.includes(t.subjectType))
    ? t.subjectType
    : 'anime'
  const episode = typeof t.episode === 'number' && t.episode >= 0 ? Math.floor(t.episode) : 0
  const total = typeof t.totalEpisodes === 'number' && t.totalEpisodes > 0 ? Math.floor(t.totalEpisodes) : undefined
  // 小说卷/章进度是字符串,允许 "SS2"「后记」这类文本,所以只 trim、不做数字校验
  const novelVolume = typeof t.novelVolume === 'string' ? t.novelVolume.trim() : ''
  const novelChapter = typeof t.novelChapter === 'string' ? t.novelChapter.trim() : ''
  const notes = Array.isArray(t.notes) ? t.notes.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : []
  const bindings = Array.isArray(t.bindings) ? t.bindings.filter(b => b && typeof b === 'object') as AnimeBinding[] : []
  // 最爱值 clamp 到 [0, FAVORITE_MAX]，老数据没这字段就当 0
  const favoriteRaw = typeof t.favorite === 'number' && t.favorite >= 0 ? Math.floor(t.favorite) : 0
  const favorite = Math.min(FAVORITE_MAX, favoriteRaw)
  // 观望次数 —— 非负整数，老数据没这字段就当 0。不设上限：UI 只在 ≥4 时
  // 高亮提示"建议升到在追"，但用户硬要继续观望不阻止。
  const observeCount = typeof t.observeCount === 'number' && t.observeCount >= 0 ? Math.floor(t.observeCount) : 0
  // 好看集 —— 老数据没这字段或不是数组就当空 []；过滤 ≤ 0 / NaN，去重、升序。
  const goodEpisodes = normalizeGoodEpisodes(t.goodEpisodes)
  // 备注剪到只剩"还被标记着的集" —— 取消标记某集时它的备注自动作废
  const goodEpisodeNotes = normalizeGoodEpisodeNotes(t.goodEpisodeNotes, goodEpisodes)
  // bgmTags 额外 slice 到 BGM_TAGS_MAX:老数据存了 8 个,read 时顺手收敛到 4 个。
  const bgmTags = normalizeTagList(t.bgmTags).slice(0, BGM_TAG_LIMIT)
  const userTags = normalizeTagList(t.userTags)
  const airDate = typeof t.airDate === 'string' ? t.airDate : undefined
  const storedWeekday = typeof t.airWeekday === 'number' && Number.isInteger(t.airWeekday)
    && t.airWeekday >= 1 && t.airWeekday <= 7
    ? t.airWeekday
    : 0
  return {
    bgmId: t.bgmId,
    subjectType,
    title: typeof t.title === 'string' ? t.title : '',
    titleCn: typeof t.titleCn === 'string' && t.titleCn.length > 0 ? t.titleCn : undefined,
    aliases: normalizeTagList(t.aliases),
    cover: typeof t.cover === 'string' && t.cover.length > 0 ? t.cover : undefined,
    status,
    episode: total != null ? Math.min(episode, total) : episode,
    totalEpisodes: total,
    airDate,
    airWeekday: storedWeekday || weekdayFromAirDate(airDate) || undefined,
    novelVolume,
    novelChapter,
    bindings,
    notes,
    favorite,
    observeCount,
    bgmTags,
    userTags,
    goodEpisodes,
    goodEpisodeNotes,
    startedAt: typeof t.startedAt === 'string' && t.startedAt ? t.startedAt : now,
    updatedAt: typeof t.updatedAt === 'string' && t.updatedAt ? t.updatedAt : now,
  }
}

function readAll(): Map<number, AnimeTrack> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return new Map()
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Map()
    const m = new Map<number, AnimeTrack>()
    for (const v of arr) {
      const t = v as Partial<AnimeTrack>
      if (typeof t?.bgmId === 'number') {
        m.set(t.bgmId, normalize({ ...t, bgmId: t.bgmId }))
      }
    }
    return m
  } catch (err) {
    // 数据损坏时**绝不静默清空**:备份坏数据 + 落盘报错,至少能人工恢复。
    backupCorrupt(STORAGE_KEY, raw)
    reportError('animeTrackStore', err)
    return new Map()
  }
}

class AnimeTrackStore {
  private cache: Map<number, AnimeTrack> | null = null
  private listeners = new Set<() => void>()

  private ensure(): Map<number, AnimeTrack> {
    if (this.cache === null) this.cache = readAll()
    return this.cache
  }

  private persist(): void {
    if (this.cache === null) return
    // 先同步通知订阅者让界面立刻更新,重的 stringify + setItem 丢给 idle 合并写盘
    // (追番上百条时这步要几百 ms,不能阻塞渲染)。
    this.listeners.forEach(cb => cb())
    scheduleStorageWrite(STORAGE_KEY, () => {
      if (this.cache === null) return
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.cache.values()]))
      } catch { /* ignore quota errors */ }
    })
  }

  /** 更新 updatedAt 并重算派生状态,返回落库后的条目。 */
  upsert(patch: Partial<AnimeTrack> & { bgmId: number }): AnimeTrack {
    const map = this.ensure()
    const prev = map.get(patch.bgmId)
    // bgmTags 锁在**第一次有内容**时,不是第一次创建时 —— 周历 / 搜索这类入口手上没有
    // detail,先写空数组再由 ensureBgmTagsFilled 异步补;锁在 create 的话这些入口的
    // 追番永远补不上 tag。一旦非空,后续 upsert 都不动它,社区 tag 漂移污染不了快照。
    const lockedBgmTags = prev && prev.bgmTags.length > 0 ? prev.bgmTags : patch.bgmTags
    const merged = normalize({
      ...prev,
      ...patch,
      bgmTags: lockedBgmTags,
      // 除非显式覆盖,否则保留原来的 startedAt
      startedAt: prev?.startedAt ?? patch.startedAt,

      updatedAt: new Date().toISOString(),
    })
    map.set(patch.bgmId, merged)
    this.persist()
    return merged
  }

  /** 设置某一集的好看集备注,trim 后为空则删除。track 不存在时 no-op。 */
  setGoodEpisodeNote(bgmId: number, ep: number, note: string): void {
    const map = this.ensure()
    const prev = map.get(bgmId)
    if (!prev) return
    const next = { ...prev.goodEpisodeNotes }
    const trimmed = note.trim()
    if (trimmed) next[ep] = trimmed
    else delete next[ep]
    this.upsert({ bgmId, goodEpisodeNotes: next })
  }

  /** 加一个用户 tag(trim + 去重,空串或已存在则 no-op)。track 不存在时 no-op。 */
  addUserTag(bgmId: number, tag: string): void {
    const map = this.ensure()
    const prev = map.get(bgmId)
    if (!prev) return
    const trimmed = tag.trim()
    if (!trimmed) return
    if (prev.userTags.includes(trimmed)) return
    this.upsert({ bgmId, userTags: [...prev.userTags, trimmed] })
  }

  /** 删除一个用户自定义 tag。tag 不存在则 no-op。 */
  removeUserTag(bgmId: number, tag: string): void {
    const map = this.ensure()
    const prev = map.get(bgmId)
    if (!prev) return
    const next = prev.userTags.filter(t => t !== tag)
    if (next.length === prev.userTags.length) return
    this.upsert({ bgmId, userTags: next })
  }

  /**
   * bgmTags 还空着时,异步拉一次 BGM detail 补上。给周历 / 搜索这类手上没有 detail 的
   * 加追番入口用:先 upsert 让 UI 立刻响应,再后台补。
   *
   * 随机延迟 800-2000ms 让用户连点 +追番 时的多次 detail 调用错峰,避免撞限流;延迟期间
   * 二次检查(track 可能已被删 / tag 已被别处补上)再决定发不发请求。
   * **失败不重试**(红线):下次 +追番 / 打开详情页 / 重启时自然会再触发一次。
   */
  async ensureBgmTagsFilled(bgmId: number): Promise<void> {
    const existing = this.getByBgmId(bgmId)
    if (!existing) return
    const hasAirMetadata = existing.airDate !== undefined
      && (existing.airDate === '' || existing.airWeekday !== undefined)
    if (existing.bgmTags.length > 0 && hasAirMetadata) return
    const jitterMs = 800 + Math.random() * 1200
    await new Promise<void>((r) => setTimeout(r, jitterMs))

    const recheck = this.getByBgmId(bgmId)
    if (!recheck) return
    const recheckHasAirMetadata = recheck.airDate !== undefined
      && (recheck.airDate === '' || recheck.airWeekday !== undefined)
    if (recheck.bgmTags.length > 0 && recheckHasAirMetadata) return
    try {
      const detail = await window.bgmApi.detail(bgmId)
      // 顺带把别名补上,零额外请求 —— 之后 MyAnime 本地搜索才能按别名命中
      const aliases = aliasesFromInfobox(detail.infobox)
      const patch: Partial<AnimeTrack> & { bgmId: number } = { bgmId }
      if (Array.isArray(detail.tags) && detail.tags.length > 0) patch.bgmTags = detail.tags
      if (aliases.length > 0) patch.aliases = aliases
      // 顺带补放送日期。空串也要写 —— 那是「确认未定档」这个有效结论
      if (recheck.airDate === undefined && typeof detail.date === 'string') {
        patch.airDate = detail.date
        const weekday = weekdayFromAirDate(detail.date)
        if (weekday) patch.airWeekday = weekday
      }
      if (patch.bgmTags || patch.aliases || 'airDate' in patch) this.upsert(patch)
    } catch { /* silent — 下次相关入口再触发时重试 */ }
  }

  getByBgmId(id: number): AnimeTrack | null {
    return this.ensure().get(id) ?? null
  }

  /** `(source, sourceKey)` → 拥有这条 binding 的 track。sourceKey 只 trim 后比较
   *  —— 各站 URL 常被带着多余空白粘进来。 */
  findByBinding(source: AnimeBinding['source'], sourceKey: string): AnimeTrack | null {
    const key = sourceKey.trim()
    if (!key) return null
    for (const t of this.ensure().values()) {
      if (t.bindings.some(b => b.source === source && b.sourceKey.trim() === key)) return t
    }
    return null
  }

  /** 给已有 track 追加 binding,没有就新建。按 (source, sourceKey) 幂等,重复的会被滤掉。 */
  bind(patch: Partial<AnimeTrack> & { bgmId: number }, binding: AnimeBinding): AnimeTrack {
    const map = this.ensure()
    const prev = map.get(patch.bgmId)
    const prevBindings = prev?.bindings ?? []
    const exists = prevBindings.some(
      b => b.source === binding.source && b.sourceKey.trim() === binding.sourceKey.trim(),
    )
    const bindings = exists ? prevBindings : [...prevBindings, binding]
    return this.upsert({ ...patch, bindings })
  }

  /** 原地改一条 binding(标题 / key / URL 可一起改),**保持它在列表里的位置**。 */
  updateBinding(
    bgmId: number,
    oldSource: AnimeBinding['source'],
    oldSourceKey: string,
    patch: Partial<Pick<AnimeBinding, 'sourceTitle' | 'sourceKey' | 'sourceUrl'>>,
  ): boolean {
    const map = this.ensure()
    const prev = map.get(bgmId)
    if (!prev) return false
    const oldKey = oldSourceKey.trim()
    let changed = false
    const next = prev.bindings.map(b => {
      if (b.source === oldSource && b.sourceKey.trim() === oldKey) {
        changed = true
        return { ...b, ...patch }
      }
      return b
    })
    if (!changed) return false
    this.upsert({ bgmId, bindings: next })
    return true
  }

  /** 只改一条 binding 的 `sourceUrl`。用于懒迁移,比如首次渲染时把 Aowu 的合成
   *  /v/{id} 换成用户可分享的 /w/{token}。 */
  setBindingSourceUrl(
    bgmId: number,
    source: AnimeBinding['source'],
    sourceKey: string,
    sourceUrl: string,
  ): void {
    const map = this.ensure()
    const prev = map.get(bgmId)
    if (!prev) return
    const key = sourceKey.trim()
    let changed = false
    const next = prev.bindings.map(b => {
      if (b.source === source && b.sourceKey.trim() === key && b.sourceUrl !== sourceUrl) {
        changed = true
        return { ...b, sourceUrl }
      }
      return b
    })
    if (!changed) return
    this.upsert({ bgmId, bindings: next })
  }

  /** 按 (source, sourceKey) 删一条 binding,删掉了返回 true。 */
  removeBinding(bgmId: number, source: AnimeBinding['source'], sourceKey: string): boolean {
    const map = this.ensure()
    const prev = map.get(bgmId)
    if (!prev) return false
    const key = sourceKey.trim()
    const next = prev.bindings.filter(b => !(b.source === source && b.sourceKey.trim() === key))
    if (next.length === prev.bindings.length) return false
    this.upsert({ bgmId, bindings: next })
    return true
  }

  delete(bgmId: number): boolean {
    const map = this.ensure()
    const removed = map.delete(bgmId)
    if (removed) this.persist()
    return removed
  }

  list(): AnimeTrack[] {
    return [...this.ensure().values()]
  }

  /** 整份替换(WebDAV 拉取用)。输入会过 normalize,残缺 / 老格式的数据也能安全落地。 */
  replaceAll(tracks: AnimeTrack[]): void {
    const next = new Map<number, AnimeTrack>()
    for (const t of tracks) next.set(t.bgmId, t)
    this.cache = next
    this.persist()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
}

export const animeTrackStore = new AnimeTrackStore()

/** 订阅整份追番列表。 */
export function useAnimeTrackList(): AnimeTrack[] {
  const [tracks, setTracks] = useState<AnimeTrack[]>(() => animeTrackStore.list())
  useEffect(() => {
    setTracks(animeTrackStore.list())
    return animeTrackStore.subscribe(() => setTracks(animeTrackStore.list()))
  }, [])
  return tracks
}

/** 按 bgmId 订阅单条追番,没加过则返回 null。 */
export function useAnimeTrack(bgmId: number | null | undefined): AnimeTrack | null {
  const [track, setTrack] = useState<AnimeTrack | null>(() =>
    bgmId != null ? animeTrackStore.getByBgmId(bgmId) : null
  )
  useEffect(() => {
    if (bgmId == null) { setTrack(null); return }
    setTrack(animeTrackStore.getByBgmId(bgmId))
    return animeTrackStore.subscribe(() => {
      setTrack(animeTrackStore.getByBgmId(bgmId))
    })
  }, [bgmId])
  return track
}

/** 按 (source, sourceKey) 订阅追番,binding 列表变化时会重新渲染;没有则返回 null。 */
export function useAnimeTrackByBinding(
  source: AnimeBinding['source'] | null | undefined,
  sourceKey: string | null | undefined,
): AnimeTrack | null {
  const [track, setTrack] = useState<AnimeTrack | null>(() =>
    source && sourceKey ? animeTrackStore.findByBinding(source, sourceKey) : null
  )
  useEffect(() => {
    if (!source || !sourceKey) { setTrack(null); return }
    setTrack(animeTrackStore.findByBinding(source, sourceKey))
    return animeTrackStore.subscribe(() => {
      setTrack(animeTrackStore.findByBinding(source, sourceKey))
    })
  }, [source, sourceKey])
  return track
}
