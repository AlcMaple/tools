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

/**
 * BGM 条目子类型。MyAnime 用这个字段做顶部 4 tab（动画/漫画/小说 + 推荐）
 * 的过滤维度。
 *
 * - `anime`  → BGM type=2（动画类目所有 platform）
 * - `manga`  → BGM type=1 + platform='漫画'
 * - `novel`  → BGM type=1 + platform='小说'
 * - `other`  → 画集 / 其他书籍类目 / 不识别 —— **不**出现在任何 UI tab,
 *              但数据保留（避免用户加了一本书后 UI 看不到）
 *
 * 派生规则见 `deriveSubjectType()`。老 track 无此字段时 normalize() 默认
 * 'anime'，零手动迁移。
 */
export type SubjectType = 'anime' | 'manga' | 'novel' | 'other'

const VALID_SUBJECT_TYPE: ReadonlyArray<SubjectType> = ['anime', 'manga', 'novel', 'other']

/**
 * 从 BGM detail 的 `type` + `platform` 推导 SubjectType。
 *
 *   - type === 2                          → 'anime'（动画的所有 platform 子类型都归 anime）
 *   - type === 1 && platform === '漫画'   → 'manga'
 *   - type === 1 && platform === '小说'   → 'novel'
 *   - type === 1 && 其他                  → 'other'（画集/其他/null）
 *   - 其他 type（音乐/游戏等）            → 'other'（实测我们不在 BGM 搜这些）
 *   - type 未知（老缓存数据 type=0）       → 看 platform 模式兜底
 */
export function deriveSubjectType(type: number, platform: string): SubjectType {
  if (type === 2) return 'anime'
  if (type === 1) {
    if (platform === '漫画') return 'manga'
    if (platform === '小说') return 'novel'
    return 'other'
  }
  // type=0 兜底：老 detail 缓存 type 缺失时用 platform 字符串猜
  if (type === 0) {
    if (platform === '漫画') return 'manga'
    if (platform === '小说') return 'novel'
    // 动画的 platform 是 TV/剧场版/OVA/WEB/动画 等，没出现"漫画/小说"就当动画
    return 'anime'
  }
  return 'other'
}

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
  /**
   * BGM 条目子类型 —— MyAnime 的 4 顶部 tab 过滤就靠这个字段。
   *
   * 老 track 没这字段时 normalize() 默认 `'anime'`，向后兼容零手动迁移。
   * 加新追番时由 caller 从 BGM detail 派生（`deriveSubjectType(type, platform)`）
   * 后写入；不应该在加追番后再变化（除非用户删了重加）。
   */
  subjectType: SubjectType
  title: string
  titleCn?: string
  /**
   * BGM 别名 —— 来自详情页 infobox 的「别名」栏（如「魔界女王候补生」的
   * 别名「魔女的考验」）。**纯粹给 MyAnime 本地搜索用**：用户搜别名也能命中
   * 这条追番，不用记官方主标题。
   *
   * 加追番那一刻从 BGM detail 写入（AnimeInfo 追番按钮 / Calendar +追番 走
   * ensureBgmTagsFilled 异步补）。BGM 别名基本不变，不做 lock，也不参与
   * 跨设备同步以外的派生。老 track 没这字段时 normalize() 默认 []。
   */
  aliases: string[]
  cover?: string
  status: AnimeStatus
  /** Last watched episode (0 = not started). */
  episode: number
  /** From BGM detail when known; left undefined for ongoing series with TBD count. */
  totalEpisodes?: number
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
  /**
   * 好看集备注 —— 键是集号，值是"为什么标它好看 / 当时哪一点吸引我"的一句话。
   * 全部可选，不写就没有。
   *
   * 跟 goodEpisodes **平行存放**（不塞进集号数组，免得动压缩/解析逻辑）。
   * normalize 时只保留「键在 goodEpisodes 里 + 值非空」的项 —— 所以取消标记
   * 某集（集号从 goodEpisodes 移除）时，它的备注会自动被剪掉，不留孤儿。
   */
  goodEpisodeNotes: Record<number, string>
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

/**
 * 从 BGM detail 的 infobox 提取「别名」并归一成 string[]。
 *
 * BGM infobox 在主进程 detail.ts 已把多别名数组拼成「、」分隔的单串
 * （如「魔女的考验、Witch Trial」）。这里按常见分隔符（、,，;；/）再切回
 * 数组，复用 normalizeTagList 去空 / 去重。infobox 缺「别名」时返回 []。
 */
export function aliasesFromInfobox(infobox: Record<string, string> | undefined | null): string[] {
  if (!infobox) return []
  const raw = infobox['别名'] ?? ''
  if (!raw) return []
  return normalizeTagList(raw.split(/[、,，;；/]/))
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
 * 规范化好看集备注 map：只保留「键是有效集号 + 在 eps 里 + 值是非空字符串」的项。
 * 取消标记某集后（集号不在 eps 里了），它的备注在这里被自然剪掉。
 */
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
  // subjectType —— 005 阶段新增。老 track 没这字段时默认 'anime'（项目历史上
  // 只有动画追番），向后兼容。非法值（外部导入数据写错）也归 'anime'。
  const subjectType: SubjectType = (t.subjectType && VALID_SUBJECT_TYPE.includes(t.subjectType))
    ? t.subjectType
    : 'anime'
  const episode = typeof t.episode === 'number' && t.episode >= 0 ? Math.floor(t.episode) : 0
  const total = typeof t.totalEpisodes === 'number' && t.totalEpisodes > 0 ? Math.floor(t.totalEpisodes) : undefined
  // 小说卷 / 章进度 —— 字符串（默认数字，允许 "SS2" / "后记" 等自定义文本）。
  // 老 track / 非小说没这俩字段时默认 ''（未开始）。只 trim 收敛，不做数字校验。
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
  // 两份标签数组各自 sanitize；规则一致（trim、过滤空串、去重、保留输入顺序）。
  // bgmTags 额外 slice 到前 4 个 —— 早期数据是 8 个，但显示策略统一改成
  // 4 个（详见 main/bgm/detail.ts 的注释）。这里 lazy migration 老 track
  // 的 8-元素数组到 4，read 时一次性收敛；持久化的写入也走 normalize 所以
  // 是 idempotent 的，老数据下次 upsert 时自动落盘成 4 个。
  const bgmTags = normalizeTagList(t.bgmTags).slice(0, BGM_TAG_LIMIT)
  const userTags = normalizeTagList(t.userTags)
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
   * 设置某一集的好看集备注。trim 后为空 → 删除该集备注；否则写入。
   * track 不存在则 no-op。集号不在 goodEpisodes 里的备注会在 normalize 时被剪掉。
   */
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
   * **动态延迟 800-2000ms**：用户连点 +追番 时（比如周历上一口气加好几部），
   * 多次派生 detail 调用错峰，避免跟主进程同期的别的 BGM 调用挤在一起
   * 触发限流。延迟期间做**二次检查**：track 可能已被删 / tag 已被别的
   * 路径补上 → 直接 short-circuit 不发请求。
   *
   * **失败处理**：catch swallow，**不重试**。下次 +追番 / 打开详情页 /
   * 重启应用时这个调用会再触发一次，符合 docs/bgm-集成参考手册.md §3
   * 「失败后不试探不重试」原则。
   *
   * 注：封面本地化**不**走 store —— track.cover 永远存可移植的 URL（要跨
   * 设备同步，存 archivist:// 本机绝对路径到别的设备会失效）。本地化只在
   * 显示时按设备各自做，见 `hooks/useCover.ts`。
   */
  async ensureBgmTagsFilled(bgmId: number): Promise<void> {
    const existing = this.getByBgmId(bgmId)
    if (!existing) return
    if (existing.bgmTags.length > 0) return
    const jitterMs = 800 + Math.random() * 1200
    await new Promise<void>((r) => setTimeout(r, jitterMs))
    // 二次检查：延迟期间用户可能删了 track / 别的路径已经把 tag 补上,
    // 这两种情况下都不需要再发请求。
    const recheck = this.getByBgmId(bgmId)
    if (!recheck || recheck.bgmTags.length > 0) return
    try {
      const detail = await window.bgmApi.detail(bgmId)
      // 同一次 detail 顺带把别名补上（零额外请求）—— 周历 +追番 没 detail,
      // 别名要靠这里回填，之后 MyAnime 本地搜索才能按别名命中。
      const aliases = aliasesFromInfobox(detail.infobox)
      const patch: Partial<AnimeTrack> & { bgmId: number } = { bgmId }
      if (Array.isArray(detail.tags) && detail.tags.length > 0) patch.bgmTags = detail.tags
      if (aliases.length > 0) patch.aliases = aliases
      if (patch.bgmTags || patch.aliases) this.upsert(patch)
    } catch { /* silent — 下次相关入口再触发时重试 */ }
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
