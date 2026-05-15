// Anime tracking store — backs the "我的状态" card on AnimeInfo and (later)
// the aggregate view + per-source bindings. Mirrors homework's storage shape:
// localStorage-only, plain class with manual subscribe, normalize on read.
//
// The canonical key is `bgmId` (Bangumi subject id) — every other surface in
// the app (xifan/girigiri/aowu search results, schedule, etc.) joins back to
// this id via a per-track `bindings[]` list, populated when the user actively
// links a source result to the track. There is *no* fuzzy title matching.

import { useEffect, useState } from 'react'

/**
 * Tracking status —— v2 把 paused / dropped 删了（用户从来没用过这俩），
 * 同时加了 considering（观望）：跟 plan（想看，已下决心追了等条件）不同,
 * considering 是"候补，看看再说"，最爱值达到一定程度用户会自己手动迁到
 * watching，不自动升级。
 */
export type AnimeStatus = 'plan' | 'watching' | 'completed' | 'considering'

export interface AnimeBinding {
  /** Capitalised to match the existing `Source` type used by SearchDownload. */
  source: 'Xifan' | 'Girigiri' | 'Aowu' | 'Bilibili' | 'Custom'
  /** Title as it appears on that source — kept for display when the user reviews their bindings. */
  sourceTitle: string
  /** Either the per-source slug/key or a full URL. */
  sourceKey: string
  /** Optional explicit URL; if omitted, callers compute it from sourceKey + source convention. */
  sourceUrl?: string
}

export interface AnimeTrack {
  bgmId: number
  title: string
  titleCn?: string
  cover?: string
  status: AnimeStatus
  /** Last watched episode (0 = not started). */
  episode: number
  /** From BGM detail when known; left undefined for ongoing series with TBD count. */
  totalEpisodes?: number
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
   * 来自 BGM 的题材标签 —— "恋爱 / 漫画改 / 2026年4月" 这种。
   *
   * **加追番那一刻锁定** —— 第一次 upsert 创建 track 时从 patch.bgmTags 写入,
   * 之后无论 BGM detail 怎么变（社区 tag 浮动、新增、删除），本地这份永远不变,
   * 直到用户删追番再重加。这是为了：
   *   1. 加载速度：MyAnime 列表不会因为 tag 漂移触发集体 re-render
   *   2. 用户预期：用户给追番打的"恋爱"分类不会某天悄悄变成"少女"消失
   *   3. 同步友好：WebDAV 上的 bgmTags 是稳定快照，不会被新 fetch 污染
   * 实现见 upsert() 里的 lock-on-create 分支。
   */
  bgmTags: string[]
  /**
   * 用户自定义标签 —— "下饭 / 通勤番" 这种用户自己加的分类。
   * 跟 bgmTags 物理隔离：用户改 userTags 不会动 bgmTags，反之亦然。
   * UI 上能加 / 删 / 任意修改，参与 WebDAV sync。
   */
  userTags: string[]
  /**
   * 好看集 —— 这部番里"哪几集"被标记为精彩的具体集号列表。
   *
   * 这是来自用户原 PDF 的概念，数据形式是「集号数组」（不是计数）。例如
   * `偶像活动: 1、4-5、16-19、25-26` 在这里存成 `[1, 4, 5, 16, 17, 18, 19, 25, 26]`。
   * 渲染时用 compressGoodEpisodes() 折回 "1、4-5、16-19、25-26"。
   *
   * 评判标准（CriteriaModal 里有完整文档，这里复述给后续维护者）：
   *   - 重温有关注点（突然停止快进，看完那一段精彩部分）
   *   - 追的过程中重看一遍某部分的集【因为推理而重看除外】
   *   - 暂停截图
   *
   * normalize 时：过滤 ≤ 0 / NaN、去重、升序排序。不夹到 totalEpisodes 上限
   * （防御性 —— totalEpisodes 可能被改小，或者数据来自迁移；越界值原样保留
   * 让用户在 UI 上能看到再决定怎么处理）。
   */
  goodEpisodes: number[]
  /** ISO date when the user first tracked this anime. */
  startedAt: string
  /** ISO date of the most recent mutation. */
  updatedAt: string
}

const STORAGE_KEY = 'maple-anime-tracks-v1'
const VALID_STATUS: ReadonlyArray<AnimeStatus> = ['plan', 'watching', 'completed', 'considering']
const FAVORITE_MAX = 6
/**
 * BGM 标签每个 track 最多显示几个（前 N 个最热门）。跟主进程
 * src/main/bgm/detail.ts 里的 slice 一致；这里 lazy migrate 老 track 的
 * 8-元素数组，避免历史数据让 UI 看着比新数据多。
 */
const BGM_TAG_LIMIT = 4

// ── 标签数组工具 ─────────────────────────────────────────────────────────────

/**
 * 标签数组规范化：trim、过滤空串 / 非字符串、去重，保留**输入顺序**。
 * 不排序——用户期望"我加的最新 tag 在末尾"那种自然顺序；BGM tag 也保留 BGM
 * 返回的原始顺序（按热度排好的）。
 */
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

// ── 好看集集号工具 ──────────────────────────────────────────────────────────

/**
 * 规范化好看集集号数组：过滤掉 ≤ 0 / 非有限数 / 非整数，去重，升序排序。
 * 单独抽出来是因为 normalize() 和 UI（编辑 modal 写入前）都要用同一套。
 */
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

/**
 * 把集号数组压缩成 PDF 里那种紧凑字符串，连续区间合并成 "a-b"：
 *   [1, 4, 5, 16, 17, 18, 19] → "1、4-5、16-19"
 * 输入应该是已经 normalize 过的（升序去重），但函数对乱序输入也能正确处理。
 */
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
 * 解析 PDF/用户手敲的紧凑字符串成集号数组：
 *   "1、4-5、16-19" → [1, 4, 5, 16, 17, 18, 19]
 *   "1,4-5,16-19"  → 同上（兼容半角逗号、空格）
 *   "1; 4 - 5"     → 同上（兼容分号、连字符两端空格）
 * 非法 token 静默忽略；返回值已 normalize（去重升序）。本函数主要给未来的
 * "粘贴 PDF 数据"导入路径用，当前 modal 编辑器不需要它，但放在 store 旁边
 * 跟 compress 对仗更顺手。
 */
export function parseGoodEpisodes(text: string): number[] {
  const out: number[] = []
  const parts = text.split(/[、,;\s]+/).map(s => s.trim()).filter(Boolean)
  for (const p of parts) {
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/)
    if (m) {
      const a = parseInt(m[1], 10)
      const b = parseInt(m[2], 10)
      if (a > 0 && b > 0) {
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        for (let i = lo; i <= hi; i++) out.push(i)
      }
      continue
    }
    const n = parseInt(p, 10)
    if (!Number.isNaN(n) && n > 0) out.push(n)
  }
  return normalizeGoodEpisodes(out)
}

/**
 * Idempotent normalize for an array of unknown tracks — used both for
 * localStorage read and for the WebDAV pull path. Filters out entries
 * without a numeric bgmId, deduplicates by bgmId (keeps the last one in
 * iteration order), and routes each through the per-entry normalizer.
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
  // 老数据里如果出现已删除的 paused/dropped，fallback 到 plan（用户说没这种
  // 数据，但读 WebDAV 老 blob / 别人导入的数据 仍然可能有；防御性兜底）
  const status = (t.status && VALID_STATUS.includes(t.status)) ? t.status : 'plan'
  const episode = typeof t.episode === 'number' && t.episode >= 0 ? Math.floor(t.episode) : 0
  const total = typeof t.totalEpisodes === 'number' && t.totalEpisodes > 0 ? Math.floor(t.totalEpisodes) : undefined
  const notes = Array.isArray(t.notes) ? t.notes.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : []
  const bindings = Array.isArray(t.bindings) ? t.bindings.filter(b => b && typeof b === 'object') as AnimeBinding[] : []
  // 最爱值 clamp 到 [0, FAVORITE_MAX]，老数据没这字段就当 0
  const favoriteRaw = typeof t.favorite === 'number' && t.favorite >= 0 ? Math.floor(t.favorite) : 0
  const favorite = Math.min(FAVORITE_MAX, favoriteRaw)
  // 好看集 —— 老数据没这字段或不是数组就当空 []；过滤 ≤ 0 / NaN，去重、升序。
  const goodEpisodes = normalizeGoodEpisodes(t.goodEpisodes)
  // 两份标签数组各自 sanitize；规则一致（trim、过滤空串、去重、保留输入顺序）。
  // bgmTags 额外 slice 到前 4 个 —— 早期数据是 8 个，但显示策略统一改成
  // 4 个（详见 main/bgm/detail.ts 的注释）。这里 lazy migration 老 track
  // 的 8-元素数组到 4，read 时一次性收敛；持久化的写入也走 normalize 所以
  // 是 idempotent 的，老数据下次 upsert 时自动落盘成 4 个。
  const bgmTags = normalizeTagList(t.bgmTags).slice(0, BGM_TAG_LIMIT)
  const userTags = normalizeTagList(t.userTags)
  return {
    bgmId: t.bgmId,
    title: typeof t.title === 'string' ? t.title : '',
    titleCn: typeof t.titleCn === 'string' && t.titleCn.length > 0 ? t.titleCn : undefined,
    cover: typeof t.cover === 'string' && t.cover.length > 0 ? t.cover : undefined,
    status,
    episode: total != null ? Math.min(episode, total) : episode,
    totalEpisodes: total,
    bindings,
    notes,
    favorite,
    bgmTags,
    userTags,
    goodEpisodes,
    startedAt: typeof t.startedAt === 'string' && t.startedAt ? t.startedAt : now,
    updatedAt: typeof t.updatedAt === 'string' && t.updatedAt ? t.updatedAt : now,
  }
}

function readAll(): Map<number, AnimeTrack> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
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
  } catch { return new Map() }
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
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.cache.values()]))
    } catch { /* ignore quota errors */ }
    this.listeners.forEach(cb => cb())
  }

  /** Touch updatedAt and recompute all derived state. Returns the stored entry. */
  upsert(patch: Partial<AnimeTrack> & { bgmId: number }): AnimeTrack {
    const map = this.ensure()
    const prev = map.get(patch.bgmId)
    // bgmTags 是 **lock-on-first-content** —— prev.bgmTags **非空**时锁定;
    // 空数组（或首次创建）时允许从 patch 接受新值。
    //
    // 早期是严格 lock-on-create（prev 存在就锁），但这导致"周历 / 搜索"
    // 这种没 detail 数据的入口写下追番后 bgmTags 永远是空的，用户必须删
    // 重加才能补。改成 lock-on-first-content 后：
    //   - "周历点追番" 立即 upsert（bgmTags=[]），再异步 ensureBgmTagsFilled
    //     补一次（patch.bgmTags 写入）—— prev.bgmTags === [] 不锁，接受
    //   - 一旦有内容（>0 个 tag），后续 upsert 都不会动它，BGM 社区 tag
    //     漂移仍然污染不了用户的快照
    // 想换 bgmTags 还是得删追番再重加（删了 prev 不存在，从头来过）。
    const lockedBgmTags = prev && prev.bgmTags.length > 0 ? prev.bgmTags : patch.bgmTags
    const merged = normalize({
      ...prev,
      ...patch,
      bgmTags: lockedBgmTags,
      // Preserve startedAt across upserts unless explicitly overwritten.
      startedAt: prev?.startedAt ?? patch.startedAt,
      // Always bump updatedAt regardless of caller.
      updatedAt: new Date().toISOString(),
    })
    map.set(patch.bgmId, merged)
    this.persist()
    return merged
  }

  /**
   * 添加一个用户自定义 tag。trim + 大小写敏感去重；空串 / 已存在直接 no-op。
   * 跟 setUserTags 比起来更点对点，UI 上"+ 添加"按钮直接调用。
   * track 不存在则 no-op（caller 应先 upsert 创建 track）。
   */
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
   * 如果 track 的 bgmTags 还是空，异步从 BGM detail 拉回完整 tag 补写。
   *
   * 用在那些"加追番"入口本身没有 detail 数据的地方（番剧周历 / 搜索结果
   * 关联追番）—— 立即 upsert 让 UI 响应，再后台调一次 detail 把 bgmTags
   * 填上。lock-on-first-content 语义保证：
   *   - 第一次成功补写后，后续重复调用 short-circuit（已经非空，prev 锁定）
   *   - 用户已经看到过的 BGM 标签快照不会被 BGM 社区 tag 漂移污染
   *
   * 失败静默（网络抖、BGM API 抽风），用户后续打开详情页 / 重新打开应用
   * 时下个调用还会再试一次，没什么副作用。
   */
  async ensureBgmTagsFilled(bgmId: number): Promise<void> {
    const existing = this.getByBgmId(bgmId)
    if (!existing) return
    if (existing.bgmTags.length > 0) return
    try {
      const detail = await window.bgmApi.detail(bgmId)
      if (Array.isArray(detail.tags) && detail.tags.length > 0) {
        this.upsert({ bgmId, bgmTags: detail.tags })
      }
    } catch { /* silent — 下次再试 */ }
  }

  getByBgmId(id: number): AnimeTrack | null {
    return this.ensure().get(id) ?? null
  }

  /**
   * Resolve `(source, sourceKey)` → the track that owns this binding, if any.
   * Used by SearchDownload to draw "已追" badges on cards the user has linked
   * before. We compare sourceKey loosely (trim) since both Aowu / Xifan watch
   * URLs and Girigiri play URLs are sometimes pasted with extra whitespace.
   */
  findByBinding(source: AnimeBinding['source'], sourceKey: string): AnimeTrack | null {
    const key = sourceKey.trim()
    if (!key) return null
    for (const t of this.ensure().values()) {
      if (t.bindings.some(b => b.source === source && b.sourceKey.trim() === key)) return t
    }
    return null
  }

  /**
   * Append a binding to an existing track or create a new one. Idempotent on
   * (source, sourceKey) — duplicate bindings are filtered out. Returns the
   * resulting track.
   */
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

  /**
   * Edit an existing binding in place by (source, sourceKey). Caller can patch
   * sourceTitle / sourceKey / sourceUrl together. Used by EditBindingsModal so
   * users can rename custom labels and fix typo'd URLs without losing the
   * binding's position. No-op if no matching binding exists.
   */
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

  /**
   * Patch a single binding's `sourceUrl` in place. Used by lazy migrations —
   * e.g. resolving Aowu's synthetic /v/{id} URL to the user-facing /w/{token}
   * form on first chip render, so subsequent clicks have a working link.
   * No-op if no matching binding is found.
   */
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

  /**
   * Remove a single binding by (source, sourceKey). No-op if the track or the
   * matching binding doesn't exist. Returns true if a binding was removed.
   */
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

  /**
   * Wholesale replace — used by the WebDAV pull path. Input is normalized so
   * partial / legacy entries still land cleanly. Persists + notifies subscribers.
   */
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

/**
 * React hook — subscribes to the full list of tracked anime. Used by the
 * aggregate "我的追番" page. Returns a stable snapshot per change event.
 */
export function useAnimeTrackList(): AnimeTrack[] {
  const [tracks, setTracks] = useState<AnimeTrack[]>(() => animeTrackStore.list())
  useEffect(() => {
    setTracks(animeTrackStore.list())
    return animeTrackStore.subscribe(() => setTracks(animeTrackStore.list()))
  }, [])
  return tracks
}

/**
 * React hook — subscribes to a single track entry by BGM id.
 * Returns null when the user has not added this anime to their list yet.
 */
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

/**
 * React hook — subscribes to a track entry by (source, sourceKey) binding.
 * Re-renders when the underlying binding list changes (e.g. user just linked
 * the card on this page). Returns null when no track owns this binding yet.
 */
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
