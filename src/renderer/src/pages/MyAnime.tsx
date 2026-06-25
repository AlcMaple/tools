// 我的追番 — aggregate view + the canonical editing surface for status / episode.
//
// AnimeInfo deliberately keeps only a Track / Untrack toggle (the sticky left
// column there has no room for editing UI). All real progress management lives
// here: a flat, scannable list grouped by status with a +1 button per row.
//
// Design notes:
// - One row per anime, no separate "detail" sub-view. Editing happens inline.
// - Status filter chips at top let the user drill into a single bucket without
//   the page collapsing into nothing when a bucket is empty.
// - WebDAV 同步是这里独立的事 —— 顶部 AnimeSyncBar 走 `anime.json`，跟阵容
//   知识库的 `homework.json` 完全分开。HomeworkLookup 不再触碰追番数据。
//   首次升级时如果 anime.json 不存在，pull 会自动从老 homework.json 的
//   tracks 字段做无感迁移（详见 AnimeSyncBar）。
// - 备注字段在 store 里仍保留（向后兼容老数据），但不再有 UI 入口。

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import TopBar from '../components/TopBar'
import {
  animeTrackStore,
  useAnimeTrackList,
  type AnimeStatus,
  type AnimeTrack,
  type SubjectType,
} from '../stores/animeTrackStore'
import { ModalShell } from './homework/shared'
import { useCover } from '../hooks/useCover'
import { useIsCompact } from '../hooks/useMediaQuery'
import coverFallback from '../assets/cover-fallback.png'
import { WatchHere } from '../components/WatchHere'
import { AddBindingModal } from '../components/AddBindingModal'
import { SearchSourceModal } from '../components/SearchSourceModal'
import { AnimeSyncBar } from '../components/AnimeSyncBar'
import {
  RecommendationView,
  REC_STATUS_META,
  countRecsByStatus,
  matchesRecommendation,
  type RecFilterKey,
} from '../components/RecommendationView'
import { useRecommendationList } from '../stores/recommendationStore'
import { QuickRecommendModal } from '../components/QuickRecommendModal'
import { NewRecommendationModal } from '../components/NewRecommendationModal'
import { CriteriaModal } from '../components/CriteriaModal'
import { GoodEpisodesEditor } from '../components/GoodEpisodesEditor'
import { TagFilter } from '../components/TagFilter'
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal'
import {
  EditBindingsModal,
  isUserAddedBinding,
  type BindingEdit,
} from '../components/EditBindingsModal'
import type { AnimeBinding } from '../stores/animeTrackStore'
import type { Source, SearchCard } from '../types/search'

// ── Status taxonomy ──────────────────────────────────────────────────────────

interface StatusMeta {
  key: AnimeStatus
  label: string
  /** Material icon name. */
  icon: string
  /** Tailwind text-color token (no slash). */
  color: string
  /** Tailwind background tint token. */
  tint: string
  /** Tailwind border-color token. */
  border: string
}

const STATUS_META: ReadonlyArray<StatusMeta> = [
  { key: 'watching',     label: '在追',  icon: 'play_arrow',   color: 'text-primary',   tint: 'bg-primary/10',   border: 'border-primary/30' },
  { key: 'plan',         label: '想看',  icon: 'visibility',   color: 'text-secondary', tint: 'bg-secondary/10', border: 'border-secondary/30' },
  { key: 'considering',  label: '观望',  icon: 'hourglass_empty', color: 'text-outline',   tint: 'bg-outline/10',   border: 'border-outline/30' },
  { key: 'completed',    label: '看完',  icon: 'check_circle', color: 'text-tertiary',  tint: 'bg-tertiary/10',  border: 'border-tertiary/30' },
]

function statusMetaOf(s: AnimeStatus): StatusMeta {
  return STATUS_META.find(m => m.key === s) ?? STATUS_META[0]
}

// ── Search match ─────────────────────────────────────────────────────────────

function matchesAnime(t: AnimeTrack, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  const hay = [
    t.title,
    t.titleCn ?? '',
    // BGM 别名 —— 搜「魔女」能命中别名「魔女的考验」的「魔界女王候补生」
    (t.aliases ?? []).join(' '),
    t.bindings.map(b => b.sourceTitle).join(' '),
  ]
    .join(' ')
    .toLowerCase()
  return hay.includes(needle)
}

/**
 * Tag 过滤 —— OR 语义：track 的 (bgmTags ∪ userTags) 命中所选**任一** tag 即放行。
 * selected 为空数组就直接放行（不过滤）。
 *
 * 大小写敏感、完全匹配——这跟字符串模糊搜索不同，tag 是离散值，模糊匹配会
 * 让 "恋爱" 和 "恋爱漫" 互相误中，所以这里用严格 equality。
 */
function matchesTags(t: AnimeTrack, selectedTags: string[]): boolean {
  if (selectedTags.length === 0) return true
  const trackTags = new Set([...t.bgmTags, ...t.userTags])
  // OR：命中所选任一类型即显示
  return selectedTags.some(tag => trackTags.has(tag))
}

// ── Top-level page ───────────────────────────────────────────────────────────

type FilterKey = 'all' | AnimeStatus
type SortKey = 'addedDesc' | 'favoriteDesc'
/**
 * 顶级 tab —— 005 阶段从「tracks / recommendations」拆成 4 平级：
 *
 *   - `anime`  → 动画追番（subjectType === 'anime'）
 *   - `manga`  → 漫画追番（subjectType === 'manga'）
 *   - `novel`  → 小说追番（subjectType === 'novel'）
 *   - `recommendations` → 推荐管理
 *
 * `'other'` 类目（画集等）**不出现在任何 tab**，按用户决策保留数据但不展示。
 */
type Tab = 'anime' | 'manga' | 'novel' | 'recommendations'

/** 3 个类目 tab 的元数据，用来生成顶部 tab 按钮 + filtered/counts 的过滤维度。 */
const CATEGORY_TABS: ReadonlyArray<{ key: 'anime' | 'manga' | 'novel'; label: string; icon: string }> = [
  { key: 'anime', label: '动画', icon: 'movie' },
  { key: 'manga', label: '漫画', icon: 'menu_book' },
  { key: 'novel', label: '小说', icon: 'auto_stories' },
]

const SORT_KEY = 'maple-anime-sort'
const TAB_KEY = 'maple-anime-tab'

// 顶栏左侧标题块 —— 替换掉 TopBar 默认的搜索框。本页在 sticky header 右侧已有
// 自己的搜索框（过滤追番/推荐），顶栏再放一个会重复，故用标题块占位。
const TITLE_SLOT = (
  <div className="flex items-center gap-4">
    <h2 className="text-2xl font-bold tracking-tighter text-primary">我的追番</h2>
    <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 hidden lg:inline">
      Anime · Manga · Novel
    </span>
  </div>
)

export default function MyAnime(): JSX.Element {
  const tracks = useAnimeTrackList()
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>(() => {
    const v = localStorage.getItem(SORT_KEY)
    return v === 'favoriteDesc' ? 'favoriteDesc' : 'addedDesc'
  })
  useEffect(() => { localStorage.setItem(SORT_KEY, sort) }, [sort])
  // 顶层 tab：动画 / 漫画 / 小说 / 推荐。
  // 默认 'anime'（用户大部分时间在这），切换时持久化，下次进来还在原 tab。
  //
  // **迁移**：005 之前的 localStorage 值是 'tracks' / 'recommendations'。
  // 看到旧的 'tracks' 自动落到 'anime'（老用户都是动画追番）。其他无效值
  // 也回退到 'anime'。
  const [tab, setTab] = useState<Tab>(() => {
    const v = localStorage.getItem(TAB_KEY)
    if (v === 'recommendations' || v === 'manga' || v === 'novel' || v === 'anime') return v
    return 'anime'
  })
  useEffect(() => { localStorage.setItem(TAB_KEY, tab) }, [tab])
  // 推荐 tab 的过滤状态 + 新建弹窗状态 —— 提到这里是为了让 sticky header
  // 跟追番 tab 结构一致（chips 在容器外，body 只是列表）。
  const [recFilter, setRecFilter] = useState<RecFilterKey>('all')
  const [newRecOpen, setNewRecOpen] = useState(false)
  // 手动添加弹窗 —— BGM 限流时无法搜索加番的兜底入口（006 阶段）。
  const [manualAddOpen, setManualAddOpen] = useState(false)
  const recs = useRecommendationList()
  // 徽章数字按 query 收窄 —— 跟追番 tab 的 counts 语义一致（搜索后徽章反映
  // 收窄范围，不是全量）。空 query 时 matchesRecommendation 全命中 = 全量。
  const recCounts = useMemo(
    () => countRecsByStatus(recs.filter(r => matchesRecommendation(r, query))),
    [recs, query],
  )
  // 推荐对方聚合 + 命中数 —— 给推荐 tab 的「推荐对方」TagFilter popover 用。全集视图
  // （不按 query/status/已选收窄），按命中数倒序，让用户看到所有推荐过的人。
  const allRecipientsWithCount = useMemo(() => {
    const counter = new Map<string, number>()
    for (const r of recs) counter.set(r.toWhom, (counter.get(r.toWhom) ?? 0) + 1)
    return [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
  }, [recs])
  // 评判标准弹窗：给 ✨ 好看集 和 🌟 最爱值 提供"什么时候 +1"的参考文档。
  // 入口是 sticky header 标题旁的 help_outline 图标。两个 tab 都能打开（最爱
  // 值在追番 tab 直接相关，但用户可能在推荐 tab 想起来要查标准，所以保持常驻）。
  const [criteriaOpen, setCriteriaOpen] = useState(false)
  // 类型过滤 —— sticky header row 3 的「类型」按钮选中的 tag 集合，OR 语义
  // （详见 matchesTags）。仅追番 tab 用；切到推荐 tab 时仍保留 state，回切
  // 不丢用户的过滤选择。
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  // 推荐 tab 的「按推荐人过滤」—— OR 语义、勾选不置顶（保留命中数顺序），跟追番的
  // 类型过滤共用 TagFilter 组件。仅推荐 tab 用；切走仍保留 state，回切不丢选择。
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([])

  // 排序：
  //   - addedDesc（默认）：按添加顺序倒序——最新追的排顶部。
  //     animeTrackStore.list() 是 Map 的插入顺序（老的在前），reverse 让
  //     最新的到顶。编辑行不会改位置（upsert 的 map.set 对已有 key 保持
  //     插入位置不变），避免"改进度被弹到顶部"的吵闹感。
  //   - favoriteDesc：按 🌟 数从高到低。同 🌟 数的按添加倒序作 tie-breaker。
  // 只在显示层做排序，store 本身仍按插入顺序持久化 —— 不动 AnimeSyncBar 的
  // snapshot diff 与 WebDAV blob 格式。
  // 当前 tab 对应的类目过滤维度。推荐 tab 不用这个（走自己的逻辑）。
  const currentCategory = tab === 'recommendations' ? null : tab

  const filtered = useMemo(() => {
    // 类目过滤先于其他 —— subjectType 决定这条记录是不是该出现在当前 tab 里。
    // 'other'（画集等）跟任何 category tab 都不匹配，所以不会出现在任何 tab。
    const byCat = currentCategory
      ? tracks.filter(t => t.subjectType === currentCategory)
      : tracks
    const byQ = byCat.filter(t => matchesAnime(t, query.trim()))
    const byTags = byQ.filter(t => matchesTags(t, selectedTags))
    const inFilter = filter === 'all' ? byTags : byTags.filter(t => t.status === filter)
    const reversed = [...inFilter].reverse()
    if (sort === 'favoriteDesc') {
      // stable sort：JS Array.prototype.sort 是稳定的（ES2019+），同
      // favorite 时保持 reversed 给的添加倒序。
      reversed.sort((a, b) => b.favorite - a.favorite)
    }
    return reversed
  }, [tracks, currentCategory, filter, query, sort, selectedTags])

  // Counts include search-narrowed + tag-filtered scope so the badges reflect
  // what would actually appear if the user clicked into each bucket.
  // **只统计当前类目下的记录** —— 比如在「漫画」tab 看到的「在追 5」是漫画
  // 在追的数量，不是全部类目加起来的，避免误导。
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, watching: 0, plan: 0, considering: 0, completed: 0 }
    for (const t of tracks) {
      if (currentCategory && t.subjectType !== currentCategory) continue
      if (!matchesAnime(t, query.trim())) continue
      if (!matchesTags(t, selectedTags)) continue
      c.all++
      c[t.status]++
    }
    return c
  }, [tracks, currentCategory, query, selectedTags])

  /** 每个类目 tab 的记录总数（不带 query / status / tag 过滤），给 tab 按钮显示徽章用 */
  const categoryCounts = useMemo(() => {
    const c = { anime: 0, manga: 0, novel: 0 }
    for (const t of tracks) {
      if (t.subjectType === 'anime') c.anime++
      else if (t.subjectType === 'manga') c.manga++
      else if (t.subjectType === 'novel') c.novel++
      // 'other' 不计 —— 不在任何 tab 露面
    }
    return c
  }, [tracks])

  // 当前类目的 tag 聚合 + 命中数 —— 给 TagFilter popover 用的输入。
  // **只统计当前类目下的 track**（跟状态计数一致）：在「动画」tab 就只列动画里
  // 出现过的类型，否则会把「漫画」类目才有的标签也列出来、选了 0 条很迷惑。
  // bgmTags ∪ userTags（每个 track 里去重），按命中数倒序。
  // 不应用 query / status / selectedTags 过滤——popover 是该类目的"全集"视图，
  // 让用户能看到自己还没选的 tag。
  const allTagsWithCount = useMemo(() => {
    const counter = new Map<string, number>()
    for (const t of tracks) {
      if (currentCategory && t.subjectType !== currentCategory) continue
      const trackTags = new Set([...t.bgmTags, ...t.userTags])
      for (const tag of trackTags) {
        counter.set(tag, (counter.get(tag) ?? 0) + 1)
      }
    }
    return [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }, [tracks, currentCategory])

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="" titleSlot={TITLE_SLOT} />

      <div className="pt-16">
        {/* Sticky header —— top-16 是为了让自己卡在 fixed TopBar（高 64px = pt-16）
            下面，不是 top-0（会让标题被 TopBar 压住露出一半）。 */}
        <div className="sticky top-16 z-30 bg-surface-container-lowest border-b border-outline-variant/10 px-4 md:px-8 py-4 md:py-5">
          <div className="flex items-end justify-between gap-4 md:gap-6 flex-wrap">
            <div>
              <div className="hidden md:flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>bookmark</span>
                <span>Anime</span>
                <span className="text-outline-variant">/</span>
                <span className="text-on-surface font-bold">我的追番</span>
              </div>
              <h1 className="text-2xl md:text-3xl font-black tracking-tighter text-on-surface">我的追番</h1>
              <p className="hidden md:block text-sm text-on-surface-variant/80 mt-1 font-label">
                状态 · 集数 · 备注 全在这里。在 BGM 详情页加进来，回到这里管理进度。
              </p>
            </div>

            <div className="flex items-center gap-2 md:gap-3 w-full md:w-auto">
              {/* 评判标准帮助按钮 —— 两个 tab 都有，告诉用户"✨ 和 🌟 该什么时候 +1"。
                  PDF 里有一套用户自己定的评判规则，本应用简化了实现但把规则文档保留下来。 */}
              <button
                type="button"
                onClick={() => setCriteriaOpen(true)}
                title="✨ 好看集 & 🌟 最爱值 的评判标准参考"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-surface-container-high border border-outline-variant/20 text-on-surface-variant/70 hover:text-primary hover:border-primary/30 hover:bg-primary/8 font-label text-[11px] uppercase tracking-widest transition-colors"
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>help_outline</span>
                <span>评判标准</span>
              </button>

              {/* 搜索框所有 tab 常驻 —— 不再只在追番 tab 出现。之前它在推荐 tab
                  被隐藏，导致标题行右侧动作组宽度变化、整块 sticky header 上下
                  跳动。常驻后布局稳定；推荐 tab 下它过滤标题 / 推荐对象（见
                  matchesRecommendation），placeholder 随 tab 自适应。 */}
              <div className="relative flex-1 md:flex-none">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-base">search</span>
                <input
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  className="w-full md:w-[320px] bg-surface-container-high border border-outline-variant/20 rounded-xl py-2.5 pl-10 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/40 focus:bg-surface-bright transition-all placeholder:text-on-surface-variant/40"
                  placeholder={tab === 'recommendations' ? '搜索推荐标题、推荐对象…' : '搜索追番标题、别名、备注…'}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                {query && (
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 hover:text-primary p-1"
                    onClick={() => setQuery('')}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Tab 导航行 —— 顶级切换「动画 / 漫画 / 小说 / 推荐」(005 阶段从
              「追番列表 / 推荐」拆出来)。
              AnimeSyncBar 永远跟着这一行 —— 三个类目 + 推荐共用同一份 anime.json
              blob 同步，每个 tab 都能看到同步状态、点上传/下载。 */}
          <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
            {/* 平板 + 桌面：分段 tab（蓝图：平板像 PC 一样用分段条） */}
            <div className="hidden md:inline-flex bg-surface-container rounded-lg p-1 border border-outline-variant/15 gap-1">
              {CATEGORY_TABS.map(c => (
                <TabButton
                  key={c.key}
                  active={tab === c.key}
                  onClick={() => setTab(c.key)}
                  icon={c.icon}
                  label={c.label}
                  count={categoryCounts[c.key]}
                />
              ))}
              <TabButton
                active={tab === 'recommendations'}
                onClick={() => setTab('recommendations')}
                icon="campaign"
                label="推荐"
                // 推荐总数（不随搜索收窄）—— 跟类目 tab 的总数徽章保持一致。
                count={recs.length}
              />
            </div>
            {/* 手机：类目下拉抽屉（替代分段 tab，减少窄屏视觉跳动） */}
            <div className="md:hidden">
              <SelectMenu
                ariaLabel="切换类目"
                value={tab}
                onChange={setTab}
                options={[
                  ...CATEGORY_TABS.map(c => ({ key: c.key, label: c.label, icon: c.icon, count: categoryCounts[c.key] })),
                  { key: 'recommendations' as const, label: '推荐', icon: 'campaign', count: recs.length },
                ]}
              />
            </div>
            <AnimeSyncBar />
          </div>

          {/* 过滤 chips 行 —— 两个 tab 共用同一行位置，内容根据 tab 切换。
              这样 sticky header 视觉结构稳定，tab 切换时不会出现"chips 跳进
              body 容器"那种突兀。右侧附件也根据 tab 切：追番 → 排序切换；
              推荐 → 新建按钮。 */}
          <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
            {/* 平板 + 桌面：分段过滤 chips */}
            <div className="hidden md:inline-flex bg-surface-container rounded-lg p-1 border border-outline-variant/15 gap-1">
              {tab !== 'recommendations' ? (
                <>
                  <FilterChip
                    active={filter === 'all'}
                    onClick={() => setFilter('all')}
                    icon="grid_view"
                    label="全部"
                    count={counts.all}
                    accent="bg-on-surface/12 text-on-surface border-on-surface/25"
                  />
                  {STATUS_META.map(m => (
                    <FilterChip
                      key={m.key}
                      active={filter === m.key}
                      onClick={() => setFilter(m.key)}
                      icon={m.icon}
                      label={m.label}
                      count={counts[m.key]}
                      accent={`${m.tint} ${m.color} ${m.border} font-bold`}
                    />
                  ))}
                </>
              ) : (
                <>
                  <FilterChip
                    active={recFilter === 'all'}
                    onClick={() => setRecFilter('all')}
                    icon="grid_view"
                    label="全部"
                    count={recCounts.all}
                    accent="bg-on-surface/12 text-on-surface border-on-surface/25"
                  />
                  {(['pending', 'accepted', 'rejected'] as const).map(k => {
                    const meta = REC_STATUS_META[k]
                    return (
                      <FilterChip
                        key={k}
                        active={recFilter === k}
                        onClick={() => setRecFilter(k)}
                        icon={meta.icon}
                        label={meta.label}
                        count={recCounts[k]}
                        accent={`${meta.tint} ${meta.color} ${meta.border} font-bold`}
                      />
                    )
                  })}
                </>
              )}
            </div>
            {/* 手机：观看状态 / 推荐状态过滤下拉 */}
            <div className="md:hidden">
              {tab !== 'recommendations' ? (
                <SelectMenu
                  ariaLabel="过滤观看状态"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { key: 'all' as FilterKey, label: '全部', icon: 'grid_view', count: counts.all },
                    ...STATUS_META.map(m => ({ key: m.key as FilterKey, label: m.label, icon: m.icon, count: counts[m.key] })),
                  ]}
                />
              ) : (
                <SelectMenu
                  ariaLabel="过滤推荐状态"
                  value={recFilter}
                  onChange={setRecFilter}
                  options={[
                    { key: 'all' as RecFilterKey, label: '全部', icon: 'grid_view', count: recCounts.all },
                    ...(['pending', 'accepted', 'rejected'] as const).map(k => ({ key: k as RecFilterKey, label: REC_STATUS_META[k].label, icon: REC_STATUS_META[k].icon, count: recCounts[k] })),
                  ]}
                />
              )}
            </div>
            {tab !== 'recommendations' ? (
              <div className="flex items-center gap-2 flex-wrap">
                {/* 类型过滤器 —— 比 SortSelector 高度优先,放它左边对齐 */}
                <TagFilter
                  allTags={allTagsWithCount}
                  selected={selectedTags}
                  onChange={setSelectedTags}
                  matchMode="OR"
                  pinSelected={false}
                />
                <SortSelector value={sort} onChange={setSort} />
                {/* 手动添加 —— BGM 限流时的兜底入口，默认 subjectType = 当前类目 tab */}
                <button
                  onClick={() => setManualAddOpen(true)}
                  title="BGM 限流搜不了时，手动添加一条追番"
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary/15 text-primary border border-primary/25 font-label text-xs font-bold tracking-widest uppercase hover:bg-primary/25 transition-all"
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>add</span>
                  添加
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {/* 按被推荐人(toWhom=B)过滤 —— OR 语义、勾选不置顶（保留命中数顺序） */}
                <TagFilter
                  allTags={allRecipientsWithCount}
                  selected={selectedRecipients}
                  onChange={setSelectedRecipients}
                  matchMode="OR"
                  pinSelected={false}
                  label="被推荐人"
                />
                <button
                  onClick={() => setNewRecOpen(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary/15 text-primary border border-primary/25 font-label text-xs font-bold tracking-widest uppercase hover:bg-primary/25 transition-all"
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>add</span>
                  新建推荐
                </button>
              </div>
            )}
          </div>

          {/* 已选过滤项不再单独占一行（避免「选中凭空多一行挤列表」或「预留空行留白」
              二选一的两难）—— 改由「类型 / 被推荐人」按钮的右上角计数角标提示，具体选了
              哪些、增删 / 清空都在该按钮的弹窗里完成（打钩 = 选，footer 有清空）。 */}
        </div>

        {/* Body —— 按 tab 切换 */}
        {tab === 'recommendations' ? (
          <RecommendationView filter={recFilter} query={query} recipients={selectedRecipients} />
        ) : tracks.length === 0 ? (
          <EmptyAll />
        ) : filtered.length === 0 ? (
          <EmptyFiltered hasQuery={!!query.trim()} statusLabel={filter === 'all' ? '' : statusMetaOf(filter).label} />
        ) : (
          // 始终单列 —— 桌面(≥1200)富信息宽行；更窄走 TrackRow 内部精简卡片
          // （见 useIsCompact）。整页左对齐铺满，不收 max-w 居中（居中会让标题/
          // 面包屑右移，像凭空多了一截 padding）。
          <div className="px-4 md:px-8 py-6 space-y-3">
            {filtered.map(t => (
              <TrackRow key={t.bgmId} track={t} />
            ))}
          </div>
        )}

        {/* 新建推荐弹窗（推荐 tab 顶部按钮触发） */}
        {newRecOpen && (
          <NewRecommendationModal onClose={() => setNewRecOpen(false)} />
        )}

        {/* 手动添加弹窗（类目 tab 顶部按钮触发）—— 默认类目 = 当前 tab */}
        {manualAddOpen && currentCategory && (
          <ManualAddModal
            defaultCategory={currentCategory}
            onClose={() => setManualAddOpen(false)}
          />
        )}

        {/* 评判标准弹窗（标题旁帮助按钮触发） */}
        {criteriaOpen && (
          <CriteriaModal onClose={() => setCriteriaOpen(false)} />
        )}
      </div>
    </div>
  )
}

// ── Manual add modal ─────────────────────────────────────────────────────────

const MANUAL_CATEGORY_OPTIONS: ReadonlyArray<{ key: SubjectType; label: string }> = [
  { key: 'anime', label: '动画' },
  { key: 'manga', label: '漫画' },
  { key: 'novel', label: '小说' },
]

/**
 * 手动添加追番 —— BGM 限流搜不了时的兜底入口（006 阶段）。
 *
 * 设计要点：
 *   - **bgmId 优先填真的**：用户从 bgm.tv 条目 URL（如 bgm.tv/subject/267215）
 *     拿到 id 填进来。填了真 id → 限流恢复后进详情页自动识别为「已追番」+
 *     拉到完整元数据（detail cache 按 bgmId 命中，跟手动 track 物理隔离，
 *     不会污染）。填不出来 → 留空，系统给负数 id 当纯本地条目。
 *   - **封面填 URL**：track.cover 存 URL（可移植 / 同步安全）；本地化在
 *     显示时由 useCover 按设备各自处理，不在这写本地路径。
 *   - **最少必填**：标题 + 类目。其他都可选 / 给默认值。
 */
function ManualAddModal({
  defaultCategory, editing, onClose,
}: {
  defaultCategory: 'anime' | 'manga' | 'novel'
  /** 传入则为「编辑」模式：预填该条目，保存时原地更新（保留状态/集数/标签等）。 */
  editing?: AnimeTrack
  onClose: () => void
}): JSX.Element {
  const isEdit = !!editing
  // 负数 id 是纯本地兜底（非真 BGM id），编辑时输入框留空；正数才回填。
  const [bgmIdInput, setBgmIdInput] = useState(editing && editing.bgmId > 0 ? String(editing.bgmId) : '')
  const [title, setTitle] = useState(editing?.title ?? '')
  const [category, setCategory] = useState<SubjectType>(
    editing ? (editing.subjectType === 'other' ? defaultCategory : editing.subjectType) : defaultCategory,
  )
  const [coverUrl, setCoverUrl] = useState(editing?.cover ?? '')
  const [totalEps, setTotalEps] = useState(editing?.totalEpisodes != null ? String(editing.totalEpisodes) : '')
  const [error, setError] = useState<string | null>(null)

  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => { titleRef.current?.focus() }, [])

  const submit = (): void => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setError('标题不能为空')
      return
    }
    // bgmId：填了正整数用真的；留空 / 非法 → 编辑时保留原 id、新增时负数兜底（-Date.now()）。
    let bgmId: number
    const raw = bgmIdInput.trim()
    if (raw) {
      const parsed = parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError('BGM ID 要么留空，要么填正整数（从 bgm.tv 条目链接里拿）')
        return
      }
      // 重名校验排除自己（编辑时 id 不变是正常的）。
      if (parsed !== editing?.bgmId && animeTrackStore.getByBgmId(parsed)) {
        setError(`BGM ID ${parsed} 已经在追番列表里了`)
        return
      }
      bgmId = parsed
    } else {
      bgmId = editing ? editing.bgmId : -Date.now()
    }

    const epsParsed = parseInt(totalEps.trim(), 10)
    // 不再有「中文标题」输入：卡片显示用 titleCn || title 回落，手动条目直接用 title 即可
    // （编辑时省略 titleCn，靠 upsert 的 ...prev 保留任何旧值，非破坏性）。
    const fields = {
      subjectType: category,
      title: trimmedTitle,
      cover: coverUrl.trim() || undefined,
      totalEpisodes: Number.isFinite(epsParsed) && epsParsed > 0 ? epsParsed : undefined,
    }

    if (editing) {
      // 编辑：不带 status/episode 默认值，避免重置进度；其余字段（标签/绑定/好看集等）由 upsert 合并保留。
      if (bgmId !== editing.bgmId) {
        // 改了 bgmId = 换 key：整条搬到新 id（保留全部进度），删掉旧的。
        animeTrackStore.delete(editing.bgmId)
        animeTrackStore.upsert({ ...editing, ...fields, bgmId })
      } else {
        animeTrackStore.upsert({ bgmId, ...fields })
      }
    } else {
      animeTrackStore.upsert({ bgmId, ...fields, status: 'plan', episode: 0 })
    }
    // 封面本地化在显示时由 useCover 处理，这里只存 URL。
    onClose()
  }

  const inputCls =
    'w-full px-3 py-2 rounded-lg bg-surface border border-outline-variant/20 text-sm text-on-surface placeholder:text-on-surface-variant/35 outline-none focus:border-primary/40 transition-colors'
  const labelCls = 'font-label text-[10px] uppercase tracking-widest text-on-surface-variant/55 mb-1.5'

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-outline-variant/10">
          <h3 className="text-base font-black tracking-tight text-on-surface">{isEdit ? '编辑追番条目' : '手动添加追番'}</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-1 font-label leading-relaxed">
            {isEdit
              ? '修改这条手动添加的追番信息（标题 / 类目 / 封面等）。观看状态、集数、标签、绑定的播放源等进度都会保留。'
              : <>BGM 限流搜不了时用这个加番。填上 BGM ID（从 bgm.tv 条目链接里拿，
                  如 <span className="font-mono text-on-surface-variant/80">bgm.tv/subject/267215</span>）,
                  限流恢复后进详情页会自动识别为已追番并补全信息。</>}
          </p>
        </div>

        {/* Body */}
        <div className="custom-scrollbar overflow-y-auto flex-1 px-6 py-5 space-y-4">
          {error && (
            <div className="rounded-lg border border-error/40 bg-error/[0.08] px-3 py-2 text-xs text-error font-label">
              {error}
            </div>
          )}

          <div>
            <p className={labelCls}>标题 *</p>
            <input
              ref={titleRef}
              className={inputCls}
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
              placeholder="原标题，如 巨蟲列島（也可直接填中文名）"
            />
          </div>

          <div>
            <p className={labelCls}>类目</p>
            <div className="inline-flex bg-surface-container rounded-lg p-1 border border-outline-variant/15 gap-1">
              {MANUAL_CATEGORY_OPTIONS.map(o => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setCategory(o.key)}
                  className={`px-3 py-1.5 rounded-md font-label text-xs tracking-widest transition-colors ${
                    category === o.key
                      ? 'bg-primary text-on-primary'
                      : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={labelCls}>BGM ID（可选）</p>
              <input
                className={`${inputCls} font-mono`}
                value={bgmIdInput}
                onChange={e => setBgmIdInput(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="如 267215"
              />
            </div>
            <div>
              <p className={labelCls}>总集 / 话数（可选）</p>
              <input
                className={`${inputCls} font-mono`}
                value={totalEps}
                onChange={e => setTotalEps(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="留空 = 连载中"
              />
            </div>
          </div>

          <div>
            <p className={labelCls}>封面图 URL（可选）</p>
            <input
              className={inputCls}
              value={coverUrl}
              onChange={e => setCoverUrl(e.target.value)}
              placeholder="贴图片链接，添加后会自动下载到本地"
            />
            <p className="text-[10px] text-on-surface-variant/40 mt-1 font-label">
              留空用占位图；填了会下载到本地，离线也能显示
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-outline-variant/10 flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            取消
          </button>
          <button
            onClick={submit}
            className="flex-1 py-2.5 rounded-lg border border-primary/40 bg-primary/10 text-primary font-bold text-sm hover:bg-primary/20 transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base leading-none">{isEdit ? 'save' : 'bookmark_add'}</span>
            {isEdit ? '保存修改' : '添加到追番'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ── Tab button ───────────────────────────────────────────────────────────────

function TabButton({
  active, onClick, icon, label, count,
}: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
  count?: number
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1.5 rounded-md font-label text-xs uppercase tracking-widest transition-colors flex items-center gap-1.5 border ${
        active
          ? 'bg-primary/15 text-primary border-primary/25'
          : 'text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high border-transparent'
      }`}
    >
      <span
        className="material-symbols-outlined"
        style={{ fontSize: 14, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}
      >
        {icon}
      </span>
      <span>{label}</span>
      {/* 计数 span 预留固定宽度 + 居中 + 等宽数字：位数变化（如 9→10）时盒子宽度
          恒定，不再把 pill 撑宽、挤动整行布局。min-w 取 3.5ch 覆盖到三位数（破百不抖）。 */}
      {count !== undefined && (
        <span className={`font-label text-[10px] tabular-nums tracking-normal text-center inline-block min-w-[3.5ch] ${active ? '' : 'text-on-surface-variant/40'}`}>{count}</span>
      )}
    </button>
  )
}

// ── Filter chip ──────────────────────────────────────────────────────────────

function FilterChip({
  active, onClick, icon, label, count, accent,
}: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
  count: number
  /** Active-state composite (bg + border + text). Only applied when `active`. */
  accent: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-1.5 rounded-md font-label text-xs uppercase tracking-widest transition-colors flex items-center gap-1.5 border ${
        active
          ? accent
          : 'text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high border-transparent'
      }`}
    >
      <span
        className="material-symbols-outlined"
        style={{ fontSize: 14, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}
      >
        {icon}
      </span>
      <span>{label}</span>
      {/* 计数 span 预留固定宽度 + 居中 + 等宽数字：位数变化（如 9→10）时盒子宽度
          恒定，不再把 pill 撑宽、挤动整行布局。min-w 取 3.5ch 覆盖到三位数（破百不抖）。 */}
      <span className={`font-label text-[10px] tabular-nums tracking-normal text-center inline-block min-w-[3.5ch] ${active ? '' : 'text-on-surface-variant/40'}`}>{count}</span>
    </button>
  )
}

// ── Mobile select dropdown ───────────────────────────────────────────────────

/**
 * 手机档把「分段 tab / 过滤 chips」收成下拉，避免一排 chip 在窄屏换行 / 横向
 * 挤压造成的视觉跳动（用户反馈「变来变去看得晕」）。平板 + 桌面仍用分段条，
 * 故本组件只在 `md:hidden` 容器里渲染。
 *
 * 泛型 T = 选项 key 的联合（FilterKey / RecFilterKey / Tab）。下拉用 absolute
 * 定位（sticky header 没有 overflow-hidden，向下溢出不会被裁），点外面 / Esc 关。
 */
function SelectMenu<T extends string>({
  options, value, onChange, ariaLabel,
}: {
  options: ReadonlyArray<{ key: T; label: string; icon: string; count?: number }>
  value: T
  onChange: (k: T) => void
  ariaLabel?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const current = options.find(o => o.key === value) ?? options[0]
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={ariaLabel}
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-surface-container border border-outline-variant/20"
      >
        <span
          className="material-symbols-outlined leading-none text-primary"
          style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}
        >
          {current.icon}
        </span>
        <span className="text-sm font-bold text-on-surface">{current.label}</span>
        {current.count !== undefined && (
          <span className="font-label text-[11px] tabular-nums text-on-surface-variant/50">{current.count}</span>
        )}
        <span className="material-symbols-outlined leading-none text-on-surface-variant/55" style={{ fontSize: 18 }}>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 z-50 min-w-[176px] bg-surface-container-high border border-outline-variant/20 rounded-xl shadow-2xl shadow-black/40 p-1.5">
          {options.map(o => {
            const active = o.key === value
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => { onChange(o.key); setOpen(false) }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                  active ? 'bg-primary/12 text-primary' : 'text-on-surface-variant/75 hover:bg-surface-container-highest hover:text-on-surface'
                }`}
              >
                <span
                  className="material-symbols-outlined leading-none"
                  style={{ fontSize: 16, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}
                >
                  {o.icon}
                </span>
                <span className="flex-1 text-sm font-medium">{o.label}</span>
                {o.count !== undefined && (
                  <span className="font-label text-[11px] tabular-nums text-on-surface-variant/45">{o.count}</span>
                )}
                {active && (
                  <span className="material-symbols-outlined leading-none text-primary" style={{ fontSize: 16 }}>check</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Track row ────────────────────────────────────────────────────────────────

// 内置三源顺序固定：常驻显示在补绑按钮里，给"还没绑过"的源画虚线按钮。
// 其他来源（Bilibili / Custom）走 AddBindingModal 单独的「+ 添加链接」入口。
const BUILTIN_SOURCES: ReadonlyArray<Source> = ['Aowu', 'Xifan', 'Girigiri']

// memo —— 列表里每行都订阅不到 store，渲染只依赖 `track` 这一个 prop。
// store.upsert 只替换被改那一条 track 的对象引用（其他 key 的对象身份不变），
// filtered 又是纯 .filter/.reverse/.sort 不克隆元素 —— 所以单条编辑 / 搜索框
// 输入触发 MyAnime 重渲染时，未变的行 props 引用不变，memo 直接跳过，避免
// 上百行整列重渲染的卡顿（这是进 MyAnime 后交互发顿的主因）。
const TrackRow = memo(function TrackRow({ track }: { track: AnimeTrack }): JSX.Element {
  const displayTitle = track.titleCn || track.title
  const nativeTitle = track.titleCn && track.title !== track.titleCn ? track.title : ''
  const coverSrc = useCover(String(track.bgmId), track.cover)
  // 删除追番要先弹 ConfirmDeleteModal —— 追番带着自定义标签、最爱值、好看集
  // 等本地数据，"双击 trash icon 真删" 那种轻量模式风险太高。
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [addingBinding, setAddingBinding] = useState(false)
  // 当前正在补搜的内置源；null = 没在搜
  const [searchingSource, setSearchingSource] = useState<Source | null>(null)
  // 「编辑」按钮打开的弹窗 —— 弹窗里集中改用户手动加的链接（标题 / URL /
  // 删除），物理隔离日常的"点 chip 跳转"操作，杜绝误删。
  // 内置三源（Aowu/Xifan/Girigiri）不在弹窗里，它们走「+ 搜 X」流程管理。
  const [editingOpen, setEditingOpen] = useState(false)
  // 「编辑条目」弹窗 —— 仅手动添加的本地条目（bgmId<0）可改标题/类目/封面等，
  // 复用 ManualAddModal 的编辑模式。BGM 同步的条目以 BGM 为准，不在这编辑。
  const [editTrackOpen, setEditTrackOpen] = useState(false)
  const isManual = track.bgmId < 0
  // 「推荐」按钮打开的弹窗 —— 让用户只填"推荐给谁"，番剧信息直接复用本行。
  // 用户的洞察："推荐的番一定在追番列表里"，所以推荐入口设在 TrackRow 是最
  // 自然的——免去再做一遍 BGM 搜索。
  const [quickRecOpen, setQuickRecOpen] = useState(false)
  const userAddedBindings = track.bindings.filter(isUserAddedBinding)
  // 小说走「卷 + 章」两级进度，且不用好看集（只留星级）——见下方计数器 / chip 的分支。
  const isNovel = track.subjectType === 'novel'

  // 哪些内置源还没绑过 —— 已绑过的隐藏「+ 搜 X」按钮，留出空间。
  const boundSources = new Set(track.bindings.map(b => b.source))
  const missingBuiltins = BUILTIN_SOURCES.filter(s => !boundSources.has(s))

  const setStatus = (s: AnimeStatus): void => {
    animeTrackStore.upsert({ bgmId: track.bgmId, status: s })
  }
  const setEpisode = (ep: number): void => {
    const total = track.totalEpisodes
    const clamped = Math.max(0, total != null ? Math.min(ep, total) : ep)
    // **不**自动把 watching 切到 completed —— 用户反馈"集数填 12 不一定是
    // 看到 12，有时候是剩下 12 还没看的备忘"，自动切 tab 会曲解用户意图。
    // 看完了由用户自己点 status segment 切到「看完」。
    const patch: Partial<AnimeTrack> & { bgmId: number } = { bgmId: track.bgmId, episode: clamped }
    // 「想看 → 在追」这个方向仍保留自动切：从 0 集开始 +1 表示"我开始看了",
    // 不存在歧义（不会有人在「想看」状态填 12 表示备忘）。
    if (clamped > 0 && track.status === 'plan') patch.status = 'watching'
    animeTrackStore.upsert(patch)
  }
  // 小说卷 / 章 setter —— 小说用「卷 + 章」两级文本进度替代 episode 数字。
  // 跟动漫 +1 一样：从「想看」首次推进就自动切「在追」（空 / "0" 不算推进）。
  const advancesFromPlan = (v: string): boolean => {
    const t = v.trim()
    return t !== '' && t !== '0' && track.status === 'plan'
  }
  const setNovelVolume = (v: string): void => {
    const patch: Partial<AnimeTrack> & { bgmId: number } = { bgmId: track.bgmId, novelVolume: v }
    if (advancesFromPlan(v)) patch.status = 'watching'
    animeTrackStore.upsert(patch)
  }
  const setNovelChapter = (v: string): void => {
    const patch: Partial<AnimeTrack> & { bgmId: number } = { bgmId: track.bgmId, novelChapter: v }
    if (advancesFromPlan(v)) patch.status = 'watching'
    animeTrackStore.upsert(patch)
  }
  const setTotalEpisodes = (n: number | undefined): void => {
    // 用户手动改总集数 —— BGM eps=0 时的逃生通道。store 的 normalize 会
    // 在新 total 比 episode 小的时候自动把 episode 夹到 total 上限,
    // 避免用户填了一个比已观看集数还小的总数导致状态不一致。
    animeTrackStore.upsert({ bgmId: track.bgmId, totalEpisodes: n })
  }
  const setFavorite = (n: number): void => {
    animeTrackStore.upsert({ bgmId: track.bgmId, favorite: n })
  }
  const setObserveCount = (n: number): void => {
    animeTrackStore.upsert({ bgmId: track.bgmId, observeCount: Math.max(0, n) })
  }
  // 好看集 setter —— 接 number[]（编辑器 modal 整批写回，已 normalize）。
  const setGoodEpisodes = (eps: number[]): void => {
    animeTrackStore.upsert({ bgmId: track.bgmId, goodEpisodes: eps })
  }
  // 好看集单集备注 setter（trim 后空 = 删除）。
  const setGoodEpisodeNote = (ep: number, note: string): void => {
    animeTrackStore.setGoodEpisodeNote(track.bgmId, ep, note)
  }
  const [goodEpsOpen, setGoodEpsOpen] = useState(false)
  // 精简布局（平板 + 手机，<lg）：卡片只直接显示 状态 / 集数 / 在线观看 / 标签，
  // 其余（最爱值 / 好看集 / 标签编辑 / 推荐 / 移除）收进右上「更多」浮层。
  // useIsCompact 用 JS 媒体查询只渲染一套卡片（不走 CSS 双树），避免上百行追番
  // 时每行 DOM 节点翻倍拖慢首屏。
  const isCompact = useIsCompact()
  // 「更多」浮层锚点矩形（null = 关闭）。卡片根是 overflow-hidden，浮层必须
  // portal 到 body 用 fixed 定位（同 NovelProgressPopover）。
  const [moreAnchor, setMoreAnchor] = useState<DOMRect | null>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const morePanelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!moreAnchor) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (
        morePanelRef.current && !morePanelRef.current.contains(t) &&
        moreBtnRef.current && !moreBtnRef.current.contains(t)
      ) {
        setMoreAnchor(null)
      }
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMoreAnchor(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreAnchor])
  // 行内"添加自定义标签" inline 输入 —— 替代了早期的 UserTagsEditor modal,
  // 因为 BGM tag 最多 4 + 用户自定义最多 4 总数 6-8 个 chip 完全能放进
  // TrackRow 一行里，专门弹个 modal 编辑反而多此一举。
  const [addingTag, setAddingTag] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const tagInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (addingTag) tagInputRef.current?.focus()
  }, [addingTag])
  const commitTag = (): void => {
    const trimmed = tagDraft.trim()
    if (trimmed) animeTrackStore.addUserTag(track.bgmId, trimmed)
    setTagDraft('')
    setAddingTag(false)
  }
  // 封面 <img> 抽出来给「桌面铺满 / 精简定高缩略图」两种容器复用，避免重复
  // onError 兜底逻辑。容器各自 relative，img 用 absolute inset-0 填满容器。
  const coverImg = (
    <img
      src={coverSrc || coverFallback}
      alt={displayTitle}
      className="absolute inset-0 w-full h-full object-cover"
      loading="lazy"
      decoding="async"
      onError={(e) => {
        const img = e.currentTarget
        if (img.src !== coverFallback) {
          img.onerror = null
          img.src = coverFallback
        }
      }}
    />
  )
  return (
    <div
      className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden flex min-h-[140px]"
      // content-visibility:auto —— 让浏览器跳过视口外行的布局/绘制（首屏只
      // 真正排版可见的几行），上百条追番时初次进入 MyAnime 的同步排版开销大幅
      // 降低；contain-intrinsic-size 给出占位高度（≈卡片下限 140），让滚动条
      // 尺寸和滚动位置保持稳定。reconciliation 仍会建全部 DOM 节点，这条只省
      // 浏览器侧的 layout/paint —— 配合上面的 memo（省 JS 重渲染）一起减负。
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 140px' }}
    >
      {/* Cover —— useCover 把 URL 解析成本地 archivist://（含老数据"回填"：
          首次渲染时后台下载，下次走本地）。没封面 / 加载失败回落占位图。

          封面用 `absolute inset-0 object-cover` 铺满 cover 容器，**不再用
          aspect-[2/3] 撑高度**。配合卡片 `min-h-[140px]`（统一高度下限，取自
          内容最高的动画卡片：标题+标签 / 状态+集数+星级 / 在线观看 三行 ≈134px,
          留余量定 140），效果：
            - cover 永远等于卡片高度 → 不会比内容高而"突出"，也不会留灰边
            - 动画 / 推荐两种卡片都被这条 floor 拉到同样的 140px，跟内容多少
              无关（同 Calendar 的固定容器思路）—— 切到推荐 tab 不再因为内容
              行数少而整块变矮、产生"挪动"感
          `relative` 给 absolute 封面做定位锚点；`overflow-hidden rounded-l-xl`
          裁掉左侧圆角处的封面溢出。 */}
      {isCompact ? (
        // 精简：封面铺满卡片高度（消除"小缩略图 + 下方留白"的割裂）；窄到手机
        // （<sm/640）干脆去掉封面——此时封面会被挤成细长条很丑，去掉给内容腾地方。
        <div className="hidden sm:block w-[96px] shrink-0 bg-surface-container-high overflow-hidden rounded-l-xl relative">
          {coverImg}
        </div>
      ) : (
        // 桌面：封面铺满卡片高度（卡片≈140，2:3 正合适），左侧圆角靠卡片 overflow-hidden 裁。
        <div className="w-[88px] shrink-0 bg-surface-container-high overflow-hidden rounded-l-xl relative">
          {coverImg}
        </div>
      )}

      {/* Body（桌面富信息版，≥lg）—— padding / gap 收紧一档让总高度≈cover 132px。
          平板 + 手机走下方 isCompact 精简版。 */}
      {!isCompact && (
      <div className="flex-1 p-3 min-w-0 flex flex-col gap-2">
        {/* Title row —— 日文原标题不再单独占一行，挪到主标题的 title attribute
            （hover 可看），把副标题位置让给类型 chip 行。这是为了在不增加卡片
            高度的前提下塞下"类型"信息。 */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3
              className="text-base font-bold text-on-surface truncate leading-tight"
              title={nativeTitle ? `${displayTitle}\n${nativeTitle}` : displayTitle}
            >
              {displayTitle}
            </h3>
            {/* 类型 chip 行：BGM 标签（primary 实色只读，加追番时的快照）+
                自定义标签（默认样式与 BGM 同主色，统一外观；hover 变红出 × 表示可删）
                + 末尾 [+ 添加] inline 入口。
                紧贴标题下方（mt-1）替代了之前的日文副标题位置，不增加卡片
                高度。 BGM 限 4 + 用户实际也不超过 4，flex-wrap 兜底超长行。 */}
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {track.bgmTags.map(t => (
                <span
                  key={`bgm-${t}`}
                  title="来自 Bangumi（不可编辑）"
                  className="inline-flex items-center px-2 py-0.5 rounded bg-primary/12 border border-primary/25 text-primary font-label text-[10px] font-bold tracking-wider"
                >
                  {t}
                </span>
              ))}
              {track.userTags.map(t => (
                <button
                  key={`user-${t}`}
                  type="button"
                  onClick={() => animeTrackStore.removeUserTag(track.bgmId, t)}
                  title={`自定义「${t}」（点击移除）`}
                  className="group inline-flex items-center gap-0.5 px-2 py-0.5 rounded bg-primary/12 border border-primary/25 text-primary hover:bg-error/15 hover:border-error/40 hover:text-error font-label text-[10px] font-bold tracking-wider transition-colors"
                >
                  <span>{t}</span>
                  <span
                    className="material-symbols-outlined leading-none opacity-0 group-hover:opacity-100 transition-opacity -mr-0.5"
                    style={{ fontSize: 11 }}
                  >
                    close
                  </span>
                </button>
              ))}
              {addingTag ? (
                <input
                  ref={tagInputRef}
                  type="text"
                  value={tagDraft}
                  onChange={e => setTagDraft(e.target.value)}
                  onBlur={commitTag}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitTag()
                    if (e.key === 'Escape') { setTagDraft(''); setAddingTag(false) }
                  }}
                  placeholder="例：下饭"
                  maxLength={20}
                  spellCheck={false}
                  className="w-24 px-2 py-0.5 rounded bg-surface border border-primary/40 outline-none focus:ring-1 focus:ring-primary/40 text-on-surface font-label text-[10px] font-bold tracking-wider"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingTag(true)}
                  title="加自定义标签（下饭 / 通勤番 之类）"
                  className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded border border-dashed border-outline-variant/35 hover:border-primary/50 hover:bg-primary/8 text-on-surface-variant/55 hover:text-primary font-label text-[10px] font-bold tracking-wider transition-colors"
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>add</span>
                  <span>添加</span>
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {isManual ? (
              // 手动本地条目（无真 BGM id）：链接入口换成「编辑」。
              <button
                onClick={() => setEditTrackOpen(true)}
                title="编辑这条手动添加的条目"
                className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px] leading-none">edit</span>
              </button>
            ) : (
              <a
                href={`https://bgm.tv/subject/${track.bgmId}`}
                target="_blank"
                rel="noreferrer"
                title="在 Bangumi 上查看"
                className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px] leading-none">open_in_new</span>
              </a>
            )}
            <button
              onClick={() => setQuickRecOpen(true)}
              title="推荐这部番给某人"
              className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px] leading-none">campaign</span>
            </button>
            <button
              onClick={() => setConfirmDeleteOpen(true)}
              title="从追番列表移除"
              className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/50 hover:text-error hover:bg-error/10 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px] leading-none">delete</span>
            </button>
          </div>
        </div>

        {/* Status + episode counter + ✨ good ep chip + 🌟 favorite stars row.
            ✨ 和 🌟 用 ml-auto 推到右端，组成一对"评分类"控件；窄屏 flex-wrap
            自动换行。
            - ✨ Good：点 +1 累加，右键 -1，点数字 inline 编辑。
            - 🌟 Stars：点星位 N 设 favorite=N，点已亮的那颗清回 0。

            观望状态特殊：右侧"评分区"显示 ObserveCounter 而不是 🌟。
            观望次数和最爱值是不同语义（观望 = "看看再说"的次数，最爱值 =
            整体喜爱程度），不能复用同一个 UI 元素。 */}
        <div className="flex items-center gap-4 flex-wrap">
          <StatusSegment current={track.status} onChange={setStatus} />
          {isNovel ? (
            <NovelProgress
              volume={track.novelVolume}
              chapter={track.novelChapter}
              onVolumeChange={setNovelVolume}
              onChapterChange={setNovelChapter}
            />
          ) : (
            <EpisodeCounter
              episode={track.episode}
              total={track.totalEpisodes}
              onChange={setEpisode}
              onTotalChange={setTotalEpisodes}
            />
          )}
          <div className="ml-auto flex items-center gap-3 flex-wrap">
            {/* 小说不用好看集（卷 / 章颗粒度跟"好看集"的单集语义对不上）——只留星级 */}
            {!isNovel && (
              <GoodEpisodesChip
                episodes={track.goodEpisodes}
                onOpen={() => setGoodEpsOpen(true)}
              />
            )}
            {track.status === 'considering' ? (
              <ObserveCounter
                value={track.observeCount}
                onChange={setObserveCount}
              />
            ) : (
              <FavoriteStars value={track.favorite} onChange={setFavorite} />
            )}
          </div>
        </div>

        {/* 在线观看 chip 行：
              - chip 全是 <a>，点了纯跳转，没有任何 hover 删除按钮
              - 右侧补绑入口：「+ 搜 X」（内置三源缺哪个显哪个）+「+ 添加链接」
              - 「编辑」按钮（仅在有用户手动加的 binding 时）打开 EditBindingsModal
                集中改 / 删 自定义链接，与跳转动作物理隔离 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/35 mr-0.5">
            在线观看
          </span>
          <WatchHere bgmId={track.bgmId} variant="inline" />
          {missingBuiltins.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setSearchingSource(s)}
              title={`在 ${s} 里搜并关联这部番`}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-dashed border-outline-variant/30 hover:border-primary/40 hover:bg-primary/8 text-on-surface-variant/50 hover:text-primary font-label text-[10px] tracking-wider transition-colors"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>search</span>
              <span>搜 {s}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setAddingBinding(true)}
            title="添加 B 站 / 自定义观看链接"
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-dashed border-outline-variant/30 hover:border-primary/40 hover:bg-primary/8 text-on-surface-variant/50 hover:text-primary font-label text-[10px] tracking-wider transition-colors"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>add</span>
            <span>添加链接</span>
          </button>
          {userAddedBindings.length > 0 && (
            <button
              type="button"
              onClick={() => setEditingOpen(true)}
              title="编辑 / 删除已添加的自定义链接"
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-outline-variant/30 hover:border-on-surface-variant/40 text-on-surface-variant/40 hover:text-on-surface-variant/70 font-label text-[10px] tracking-wider transition-colors"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>edit</span>
              <span>编辑</span>
            </button>
          )}
        </div>
      </div>
      )}

      {/* Body（平板 + 手机精简版，<lg）——
          只直接显示：标题 / 标签(只读) / 状态 / 集数·进度 / 在线观看。
          最爱值 / 好看集 / 标签编辑 / 推荐 / 移除 收进右上「更多」浮层。 */}
      {isCompact && (
        <div className="flex-1 p-3 min-w-0 flex flex-col gap-2.5">
          {/* 标题 + 更多 */}
          <div className="flex items-start justify-between gap-2">
            <h3
              className="text-[15px] font-bold text-on-surface leading-snug min-w-0 line-clamp-2"
              title={nativeTitle ? `${displayTitle}\n${nativeTitle}` : displayTitle}
            >
              {displayTitle}
            </h3>
            <button
              ref={moreBtnRef}
              onClick={() => setMoreAnchor(moreAnchor ? null : moreBtnRef.current?.getBoundingClientRect() ?? null)}
              title="更多操作（最爱值 / 好看集 / 标签 / 推荐 / 移除）"
              className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center border border-outline-variant/15 text-on-surface-variant/55 hover:text-primary hover:bg-primary/10 transition-colors"
            >
              <span className="material-symbols-outlined text-[18px] leading-none">more_vert</span>
            </button>
          </div>

          {/* 标签（只读展示；增删在「更多」浮层里） */}
          {(track.bgmTags.length > 0 || track.userTags.length > 0) && (
            <div className="flex flex-wrap items-center gap-1">
              {track.bgmTags.map(t => (
                <span key={`bgm-${t}`} className="inline-flex items-center px-2 py-0.5 rounded bg-primary/12 border border-primary/25 text-primary font-label text-[10px] font-bold tracking-wider">{t}</span>
              ))}
              {track.userTags.map(t => (
                <span key={`user-${t}`} className="inline-flex items-center px-2 py-0.5 rounded bg-primary/12 border border-primary/25 text-primary font-label text-[10px] font-bold tracking-wider">{t}</span>
              ))}
            </div>
          )}

          {/* 状态 + 进度同一行：平板够宽并排、手机自动换行 —— 既用上平板的横向
              空间、又压低卡片高度（封面不会被拉太长）。状态条超窄屏可能略超 body，
              min-w-0 + 横向滚动兜底，避免被卡片 overflow-hidden 裁掉「看完」。 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 max-w-full overflow-x-auto [&::-webkit-scrollbar]:h-0">
              <StatusSegment current={track.status} onChange={setStatus} />
            </div>
            {isNovel ? (
              <NovelProgress
                volume={track.novelVolume}
                chapter={track.novelChapter}
                onVolumeChange={setNovelVolume}
                onChapterChange={setNovelChapter}
              />
            ) : (
              <EpisodeCounter
                episode={track.episode}
                total={track.totalEpisodes}
                onChange={setEpisode}
                onTotalChange={setTotalEpisodes}
              />
            )}
          </div>

          {/* 在线观看（与桌面版同款控件） */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/35 mr-0.5">在线观看</span>
            <WatchHere bgmId={track.bgmId} variant="inline" />
            {missingBuiltins.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setSearchingSource(s)}
                title={`在 ${s} 里搜并关联这部番`}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-dashed border-outline-variant/30 hover:border-primary/40 hover:bg-primary/8 text-on-surface-variant/50 hover:text-primary font-label text-[10px] tracking-wider transition-colors"
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>search</span>
                <span>搜 {s}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setAddingBinding(true)}
              title="添加 B 站 / 自定义观看链接"
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-dashed border-outline-variant/30 hover:border-primary/40 hover:bg-primary/8 text-on-surface-variant/50 hover:text-primary font-label text-[10px] tracking-wider transition-colors"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>add</span>
              <span>添加链接</span>
            </button>
            {userAddedBindings.length > 0 && (
              <button
                type="button"
                onClick={() => setEditingOpen(true)}
                title="编辑 / 删除已添加的自定义链接"
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-outline-variant/30 hover:border-on-surface-variant/40 text-on-surface-variant/40 hover:text-on-surface-variant/70 font-label text-[10px] tracking-wider transition-colors"
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>edit</span>
                <span>编辑</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 「更多」浮层（仅精简卡片）—— 把次要操作集中到此。向下空间不足时贴按钮
          上沿向上展开（用 bottom 锚定自适应高度）。 */}
      {isCompact && moreAnchor && createPortal(
        (() => {
          const W = 288
          const left = Math.max(12, Math.min(moreAnchor.right - W, window.innerWidth - W - 12))
          const openUp = moreAnchor.bottom > window.innerHeight * 0.6
          const vstyle = openUp
            ? { bottom: window.innerHeight - moreAnchor.top + 8 }
            : { top: moreAnchor.bottom + 8 }
          return (
            <div
              ref={morePanelRef}
              style={{ position: 'fixed', left, width: W, zIndex: 9999, ...vstyle }}
              className="bg-surface-container-high border border-outline-variant/20 rounded-xl shadow-2xl shadow-black/40 p-3 flex flex-col gap-3"
            >
              {/* 最爱值 / 观望次数 */}
              <div className="flex items-center justify-between gap-2">
                <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/55">
                  {track.status === 'considering' ? '观望次数' : '最爱值'}
                </span>
                {track.status === 'considering' ? (
                  <ObserveCounter value={track.observeCount} onChange={setObserveCount} />
                ) : (
                  <FavoriteStars value={track.favorite} onChange={setFavorite} />
                )}
              </div>

              {/* 好看集（小说不显示） */}
              {!isNovel && (
                <div className="flex items-center justify-between gap-2">
                  <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/55">好看集</span>
                  <GoodEpisodesChip
                    episodes={track.goodEpisodes}
                    onOpen={() => { setMoreAnchor(null); setGoodEpsOpen(true) }}
                  />
                </div>
              )}

              {/* 标签增删 */}
              <div className="flex flex-col gap-1.5">
                <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/55">标签</span>
                <div className="flex flex-wrap items-center gap-1">
                  {track.bgmTags.map(t => (
                    <span key={`bgm-${t}`} title="来自 Bangumi（不可编辑）" className="inline-flex items-center px-2 py-0.5 rounded bg-primary/12 border border-primary/25 text-primary font-label text-[10px] font-bold tracking-wider">{t}</span>
                  ))}
                  {track.userTags.map(t => (
                    <button
                      key={`user-${t}`}
                      type="button"
                      onClick={() => animeTrackStore.removeUserTag(track.bgmId, t)}
                      title={`自定义「${t}」（点击移除）`}
                      className="group inline-flex items-center gap-0.5 px-2 py-0.5 rounded bg-primary/12 border border-primary/25 text-primary hover:bg-error/15 hover:border-error/40 hover:text-error font-label text-[10px] font-bold tracking-wider transition-colors"
                    >
                      <span>{t}</span>
                      <span className="material-symbols-outlined leading-none" style={{ fontSize: 11 }}>close</span>
                    </button>
                  ))}
                  {addingTag ? (
                    <input
                      ref={tagInputRef}
                      type="text"
                      value={tagDraft}
                      onChange={e => setTagDraft(e.target.value)}
                      onBlur={commitTag}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitTag()
                        if (e.key === 'Escape') { setTagDraft(''); setAddingTag(false) }
                      }}
                      placeholder="例：下饭"
                      maxLength={20}
                      spellCheck={false}
                      className="w-24 px-2 py-0.5 rounded bg-surface border border-primary/40 outline-none focus:ring-1 focus:ring-primary/40 text-on-surface font-label text-[10px] font-bold tracking-wider"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAddingTag(true)}
                      title="加自定义标签（下饭 / 通勤番 之类）"
                      className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded border border-dashed border-outline-variant/35 hover:border-primary/50 hover:bg-primary/8 text-on-surface-variant/55 hover:text-primary font-label text-[10px] font-bold tracking-wider transition-colors"
                    >
                      <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>add</span>
                      <span>添加</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="h-px bg-outline-variant/15 -mx-1" />

              {/* 次要动作 */}
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => { setMoreAnchor(null); setQuickRecOpen(true) }}
                  className="flex items-center gap-2.5 px-2 py-2 rounded-lg text-left text-on-surface-variant/80 hover:bg-surface-container-highest hover:text-on-surface transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px] leading-none">campaign</span>
                  <span className="text-sm">推荐这部番</span>
                </button>
                {isManual ? (
                  <button
                    type="button"
                    onClick={() => { setMoreAnchor(null); setEditTrackOpen(true) }}
                    className="flex items-center gap-2.5 px-2 py-2 rounded-lg text-left text-on-surface-variant/80 hover:bg-surface-container-highest hover:text-on-surface transition-colors"
                  >
                    <span className="material-symbols-outlined text-[16px] leading-none">edit</span>
                    <span className="text-sm">编辑条目</span>
                  </button>
                ) : (
                  <a
                    href={`https://bgm.tv/subject/${track.bgmId}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setMoreAnchor(null)}
                    className="flex items-center gap-2.5 px-2 py-2 rounded-lg text-left text-on-surface-variant/80 hover:bg-surface-container-highest hover:text-on-surface transition-colors"
                  >
                    <span className="material-symbols-outlined text-[16px] leading-none">open_in_new</span>
                    <span className="text-sm">在 Bangumi 查看</span>
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => { setMoreAnchor(null); setConfirmDeleteOpen(true) }}
                  className="flex items-center gap-2.5 px-2 py-2 rounded-lg text-left text-error/85 hover:bg-error/10 hover:text-error transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px] leading-none">delete</span>
                  <span className="text-sm">移除追番</span>
                </button>
              </div>
            </div>
          )
        })(),
        document.body,
      )}

      {addingBinding && (
        <AddBindingModal
          animeTitle={displayTitle}
          existing={track.bindings}
          onClose={() => setAddingBinding(false)}
          onConfirm={(binding: AnimeBinding) => {
            // bind() preserves existing track fields when prev exists — passing
            // bgmId alone is enough; we just need the binding write to land.
            animeTrackStore.bind({ bgmId: track.bgmId }, binding)
            setAddingBinding(false)
          }}
        />
      )}

      {searchingSource && (
        <SearchSourceModal
          source={searchingSource}
          initialKeyword={track.titleCn || track.title}
          animeTitle={displayTitle}
          onClose={() => setSearchingSource(null)}
          onConfirm={async (card: SearchCard) => {
            // Aowu 的 card.key 是 /v/{numericId} 合成 URL，浏览器打开会
            // 报错。和 SearchDownload 的关联追番一样，写 binding 前先
            // resolveShareUrl 拿到 /w/{token}#s=&ep=1 存到 sourceUrl。
            // Xifan / Girigiri 的 card.key 本身就是真实 watch URL，直接用。
            let sourceUrl: string | undefined
            if (card.source === 'Aowu') {
              try {
                sourceUrl = await window.aowuApi.resolveShareUrl(card.key)
              } catch (err) {
                console.warn('[MyAnime] aowu resolveShareUrl failed:', err)
              }
            }
            const binding: AnimeBinding = {
              source: card.source,
              sourceTitle: card.title,
              sourceKey: card.key,
              sourceUrl,
            }
            animeTrackStore.bind({ bgmId: track.bgmId }, binding)
            setSearchingSource(null)
          }}
        />
      )}

      {editingOpen && (
        <EditBindingsModal
          animeTitle={displayTitle}
          bindings={track.bindings}
          onClose={() => setEditingOpen(false)}
          onSave={(changes: BindingEdit[]) => {
            // 把 modal 攒下的改动一次性 commit 到 store。modal 已经做过
            // 校验（URL 合法 / 标题非空 / URL 去重），这里只需 dispatch。
            for (const c of changes) {
              if (c.kind === 'delete') {
                animeTrackStore.removeBinding(track.bgmId, c.originalSource, c.originalSourceKey)
              } else if (c.patch) {
                animeTrackStore.updateBinding(track.bgmId, c.originalSource, c.originalSourceKey, c.patch)
              }
            }
            setEditingOpen(false)
          }}
        />
      )}

      {quickRecOpen && (
        <QuickRecommendModal
          track={track}
          onClose={() => setQuickRecOpen(false)}
        />
      )}

      {goodEpsOpen && (
        <GoodEpisodesEditor
          animeTitle={displayTitle}
          episodes={track.goodEpisodes}
          notes={track.goodEpisodeNotes}
          totalEpisodes={track.totalEpisodes}
          episode={track.episode}
          onChange={setGoodEpisodes}
          onSetNote={setGoodEpisodeNote}
          onClose={() => setGoodEpsOpen(false)}
        />
      )}

      {confirmDeleteOpen && (
        <ConfirmDeleteModal
          title="移除追番"
          itemName={displayTitle}
          description="这部番会从追番列表里移除，本地的自定义标签、最爱值、好看集等数据也会一起清掉。若没同步到云端就无法恢复。"
          confirmText="移除"
          onCancel={() => setConfirmDeleteOpen(false)}
          onConfirm={() => {
            animeTrackStore.delete(track.bgmId)
            setConfirmDeleteOpen(false)
          }}
        />
      )}

      {/* 编辑手动条目（复用 ManualAddModal 的编辑模式） */}
      {editTrackOpen && (
        <ManualAddModal
          editing={track}
          defaultCategory={track.subjectType === 'other' ? 'anime' : track.subjectType}
          onClose={() => setEditTrackOpen(false)}
        />
      )}
    </div>
  )
})

// ── Status segment ───────────────────────────────────────────────────────────

function StatusSegment({
  current, onChange,
}: { current: AnimeStatus; onChange: (s: AnimeStatus) => void }): JSX.Element {
  return (
    <div className="inline-flex bg-surface border border-outline-variant/15 rounded-md p-0.5 gap-0.5">
      {STATUS_META.map(m => {
        const active = current === m.key
        return (
          <button
            key={m.key}
            onClick={() => onChange(m.key)}
            title={m.label}
            className={`px-2.5 py-1 rounded font-label text-[10px] tracking-widest uppercase transition-colors flex items-center gap-1 ${
              active
                ? `${m.tint} ${m.color} font-bold`
                : 'text-on-surface-variant/50 hover:text-on-surface hover:bg-surface-container'
            }`}
          >
            <span
              className="material-symbols-outlined leading-none"
              style={{ fontSize: 13, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}
            >
              {m.icon}
            </span>
            {/* 超窄屏（<420）只留图标、隐藏文字，避免「在追」之类被挤到第二行；
                button 上有 title tooltip 兜底语义。桌面富卡片 ≥1200 永远显示文字。 */}
            <span className="hidden min-[420px]:inline">{m.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Episode counter ──────────────────────────────────────────────────────────

function EpisodeCounter({
  episode, total, onChange, onTotalChange,
}: {
  episode: number
  total: number | undefined
  onChange: (n: number) => void
  /** 用户改"总集数"。BGM 长篇连载番（柯南 / 海贼）和剧场版 / OVA 那种
   *  eps=0 的条目在我们这边会显示成 "?"，用户可以点 "?" 自己填一个目标值。 */
  onTotalChange: (n: number | undefined) => void
}): JSX.Element {
  const atMax = total != null && episode >= total
  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        onClick={() => onChange(episode - 1)}
        disabled={episode <= 0}
        title="上一集"
        className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-high transition-colors disabled:opacity-30 disabled:cursor-not-allowed border border-outline-variant/15"
      >
        <span className="material-symbols-outlined text-[16px] leading-none">remove</span>
      </button>

      {/* Episode display — editable inline so the user can jump to a specific
          ep without spamming +1. */}
      <EpisodeInput
        episode={episode}
        total={total}
        onCommit={onChange}
        onTotalCommit={onTotalChange}
      />

      {/* +1 is always primary-colored — it's the headline "I watched another
          ep" action and the status segment to the left already conveys the
          current state via its own tint. */}
      <button
        onClick={() => onChange(episode + 1)}
        disabled={atMax}
        title="看下一集"
        className={`h-7 px-3 rounded-md flex items-center justify-center gap-1 font-label text-[11px] uppercase tracking-widest border transition-colors ${
          atMax
            ? 'border-outline-variant/15 text-on-surface-variant/30 cursor-not-allowed'
            : 'border-primary/30 text-primary bg-primary/10 hover:bg-primary/20'
        }`}
      >
        <span className="material-symbols-outlined text-[14px] leading-none">add</span>
        <span>+1</span>
      </button>
    </div>
  )
}

function EpisodeInput({
  episode, total, onCommit, onTotalCommit,
}: {
  episode: number
  total: number | undefined
  onCommit: (n: number) => void
  onTotalCommit: (n: number | undefined) => void
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const [totalDraft, setTotalDraft] = useState<string | null>(null)
  const display = draft ?? String(episode)
  const totalDisplay = totalDraft ?? (total != null ? String(total) : '')

  // total 未填 + 未在编辑：显示「连载中」徽章而不是空输入框。
  // 这个状态对新番 / 长寿番（BGM eps=0）/ 任何还没完结的番都成立 ——
  // 比 "?" 更明确，又同时是"点这里能填总集数"的入口（点徽章切到 input）。
  const showOngoingBadge = totalDraft === null && total == null

  const commit = (): void => {
    if (draft === null) return
    const parsed = parseInt(draft, 10)
    if (!Number.isNaN(parsed)) onCommit(parsed)
    setDraft(null)
  }
  const commitTotal = (): void => {
    if (totalDraft === null) return
    const trimmed = totalDraft.trim()
    if (trimmed === '') {
      // 清空 = 标记回「连载中」（store 里 totalEpisodes = undefined）
      onTotalCommit(undefined)
    } else {
      const parsed = parseInt(trimmed, 10)
      if (!Number.isNaN(parsed) && parsed > 0) onTotalCommit(parsed)
    }
    setTotalDraft(null)
  }

  return (
    <div className="inline-flex items-center gap-1 px-2 h-7 rounded-md bg-surface border border-outline-variant/15 font-mono text-xs">
      <input
        type="text"
        inputMode="numeric"
        value={display}
        onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onFocus={() => setDraft(String(episode))}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.currentTarget.blur() }
          if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() }
        }}
        className="w-7 bg-transparent outline-none text-center text-on-surface"
      />
      <span className="text-on-surface-variant/40">/</span>
      {showOngoingBadge ? (
        // 「连载中」状态徽章 —— 点击切到 input，用户可以填一个最终总集数
        // （完结了 / 知道了就填，不知道就保持连载中）。
        <button
          type="button"
          onClick={() => setTotalDraft('')}
          title="正在连载中。点击填入最终总集数（留空保持连载中）"
          className="inline-flex items-center h-5 px-1.5 -mx-0.5 rounded bg-primary/15 hover:bg-primary/25 text-primary/85 hover:text-primary font-label text-[9px] uppercase tracking-wider transition-colors cursor-pointer"
        >
          <span className="font-bold">连载中</span>
        </button>
      ) : (
        <input
          type="text"
          inputMode="numeric"
          value={totalDisplay}
          autoFocus={totalDraft === ''}
          onChange={e => setTotalDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onFocus={() => setTotalDraft(total != null ? String(total) : '')}
          onBlur={commitTotal}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.currentTarget.blur() }
            if (e.key === 'Escape') { setTotalDraft(null); e.currentTarget.blur() }
          }}
          placeholder="?"
          title="改总集数（留空 = 标记为连载中）"
          className="w-7 bg-transparent outline-none text-center text-on-surface-variant/70 hover:text-on-surface focus:text-on-surface placeholder:text-on-surface-variant/40"
        />
      )}
    </div>
  )
}

// ── Novel progress（小说进度：卷 + 章 两级）──────────────────────────────────

/**
 * 小说不像动漫 / 漫画一集一个数字 —— 内容是「卷（一级）+ 章（二级）」两级，且卷 / 章
 * 既可能是数字也可能是「SS2 / 短篇 / 后记」这种自定义文本。行内步进器塞不下变长的
 * 文本（数字够窄、文本要么截断要么撑爆），所以这里走应用里成熟的「紧凑 chip → 点开
 * 浮层编辑」范式（同 ✨ 好看集 / TagFilter）：
 *   - 卡片行上只占一个 chip，显示「卷 X · 章 Y」，长文本 truncate + hover 看全（行永远整齐）
 *   - 点 chip 弹出浮层，里头两行 NovelLevel 有充足宽度容纳自定义文本，+/- 步进只在
 *     当前值是纯整数时可用
 * 不显示"总数"：小说卷数没有动漫"总集数"那种确定语义（常连载 / 含番外），只记读到哪。
 */
function NovelProgress({
  volume, chapter, onVolumeChange, onChapterChange,
}: {
  volume: string
  chapter: string
  onVolumeChange: (v: string) => void
  onChapterChange: (v: string) => void
}): JSX.Element {
  // 浮层锚点 —— 存 chip 的视口矩形（非 null = 打开）。卡片根是 overflow-hidden，
  // 绝对定位浮层会被裁，所以浮层 portal 到 body 用 fixed 坐标（同 NotePopover）。
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const started = volume !== '' || chapter !== ''
  const open = anchor !== null

  const toggle = (): void => {
    if (open) { setAnchor(null); return }
    if (btnRef.current) setAnchor(btnRef.current.getBoundingClientRect())
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={started ? `卷 ${volume || '—'} · 章 ${chapter || '—'}（点击编辑）` : '记录阅读进度（卷 / 章）'}
        className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border transition-colors ${
          started
            ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
            : 'bg-surface border-dashed border-outline-variant/30 text-on-surface-variant/55 hover:border-primary/40 hover:text-primary'
        }`}
      >
        <span
          className="material-symbols-outlined leading-none shrink-0"
          style={{ fontSize: 14, fontVariationSettings: started ? "'FILL' 1" : "'FILL' 0" }}
        >
          menu_book
        </span>
        {started ? (
          <span className="font-mono text-xs max-w-[15rem] truncate">
            卷 {volume || '—'} · 章 {chapter || '—'}
          </span>
        ) : (
          <span className="font-label text-[10px] uppercase tracking-widest">记录进度</span>
        )}
      </button>

      {open && (
        <NovelProgressPopover
          anchor={anchor}
          anchorEl={btnRef.current}
          volume={volume}
          chapter={chapter}
          onVolumeChange={onVolumeChange}
          onChapterChange={onChapterChange}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  )
}

/**
 * 卷 / 章 编辑浮层。portal 到 body（避开卡片 overflow-hidden 裁剪），fixed 坐标
 * 锚定在 chip 下方、贴底翻上方。点浮层 + chip 以外关闭，Esc 关闭。
 */
function NovelProgressPopover({
  anchor, anchorEl, volume, chapter, onVolumeChange, onChapterChange, onClose,
}: {
  anchor: DOMRect
  anchorEl: HTMLElement | null
  volume: string
  chapter: string
  onVolumeChange: (v: string) => void
  onChapterChange: (v: string) => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // 排除 chip 本身：点 chip 由它自己的 onClick 负责 toggle 关闭，这里若也关一次
    // 会和 onClick 的重新打开打架（mousedown 先关、click 再开 → 关不掉）。
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current && !ref.current.contains(t) && anchorEl && !anchorEl.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorEl, onClose])

  const W = 268
  const H = 156
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - W - 12))
  const top = anchor.bottom + 8 + H > window.innerHeight ? Math.max(12, anchor.top - H - 8) : anchor.bottom + 8

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', top, left, width: W, zIndex: 9999 }}
      className="bg-surface-container-high border border-outline-variant/20 rounded-xl shadow-2xl shadow-black/30 p-3"
    >
      <div className="flex flex-col gap-2">
        <NovelLevel label="卷" value={volume} onChange={onVolumeChange} />
        <NovelLevel label="章" value={chapter} onChange={onChapterChange} />
      </div>
      <p className="mt-2.5 font-body text-[10px] text-on-surface-variant/45 leading-relaxed">
        默认填数字，+ / − 步进；也可直接填「SS2 / 短篇 / 后记」等自定义文本（此时步进禁用）。
      </p>
    </div>,
    document.body,
  )
}

function NovelLevel({
  label, value, onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  // draft：编辑中本地态，blur / Enter 才 commit（跟 EpisodeInput 一致）。
  const [draft, setDraft] = useState<string | null>(null)
  const display = draft ?? value
  // 纯整数才能 +/- 步进；"SS2" / "后记" 这类自定义文本禁用步进（直接改输入框）。
  const num = /^\d+$/.test(value) ? parseInt(value, 10) : null

  const commit = (): void => {
    if (draft === null) return
    onChange(draft.trim())
    setDraft(null)
  }
  const step = (delta: number): void => {
    if (num === null) return
    onChange(String(Math.max(0, num + delta)))
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-5 shrink-0 text-center font-label text-[11px] text-on-surface-variant/60">
        {label}
      </span>
      <button
        onClick={() => step(-1)}
        disabled={num === null || num <= 0}
        title={`上一${label}`}
        className="w-7 h-7 shrink-0 rounded-md flex items-center justify-center text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-high transition-colors disabled:opacity-30 disabled:cursor-not-allowed border border-outline-variant/15"
      >
        <span className="material-symbols-outlined text-[16px] leading-none">remove</span>
      </button>
      {/* 浮层里输入框 flex-1 占满整行宽度 —— 自定义文本（"if「就算大家很年幼」"）
          有充足空间显示，不再像行内方案那样被截断 / 撑爆卡片。 */}
      <input
        type="text"
        value={display}
        onChange={e => setDraft(e.target.value)}
        onFocus={() => setDraft(value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.currentTarget.blur() }
          if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() }
        }}
        placeholder="—"
        className="flex-1 min-w-0 h-7 px-2 rounded-md bg-surface border border-outline-variant/15 outline-none text-center font-mono text-xs text-on-surface placeholder:text-on-surface-variant/35 focus:border-primary/40 transition-colors"
      />
      <button
        onClick={() => step(1)}
        disabled={num === null}
        title={num === null ? '当前是自定义文本，无法 +1（改成数字后可用）' : `下一${label}`}
        className="w-7 h-7 shrink-0 rounded-md flex items-center justify-center border transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-primary border-primary/30 bg-primary/10 hover:bg-primary/20 disabled:text-on-surface-variant/30 disabled:border-outline-variant/15 disabled:bg-transparent"
      >
        <span className="material-symbols-outlined text-[16px] leading-none">add</span>
      </button>
    </div>
  )
}

// ── Sort selector ────────────────────────────────────────────────────────────

/**
 * 两段排序切换：「添加日期」（最新追的在顶）/ 「🌟 数」（最爱的在顶）。
 * 持久化键是 maple-anime-sort，跟过滤 chip 一样是 UI 状态，不进 store。
 */
function SortSelector({
  value, onChange,
}: {
  value: SortKey
  onChange: (v: SortKey) => void
}): JSX.Element {
  const options: Array<{ key: SortKey; label: string; icon: string }> = [
    { key: 'addedDesc',    label: '添加日期', icon: 'schedule' },
    { key: 'favoriteDesc', label: '🌟 数',   icon: 'star' },
  ]
  return (
    <div
      className="inline-flex bg-surface-container rounded-md p-0.5 border border-outline-variant/15 gap-0.5"
      title="排序方式"
    >
      {options.map(o => {
        const active = o.key === value
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={`px-2 py-1 rounded font-label text-[10px] uppercase tracking-widest transition-colors flex items-center gap-1 ${
              active
                ? 'bg-primary/15 text-primary'
                : 'text-on-surface-variant/55 hover:text-on-surface hover:bg-surface-container-high'
            }`}
          >
            <span
              className="material-symbols-outlined leading-none"
              style={{ fontSize: 12, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}
            >
              {o.icon}
            </span>
            <span>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Good episodes chip ───────────────────────────────────────────────────────

/**
 * ✨ 好看集 chip —— 入口按钮，不展示具体集号。
 *
 * 设计取舍：早先版本在 chip 里压缩展示 "1、4-5、16-19"，但用户决定让 chip
 * 始终只做"入口"角色——具体内容到 modal 里看。这样：
 *   - 行视觉永远整齐，长寿番（柯南标到 100+）也不会撑乱 TrackRow
 *   - 跟左侧的「标这集」按钮在视觉权重上对等
 *   - 用户对 row 的快速扫描时不被一长串数字干扰
 *
 * 状态只用颜色 + 边框样式区分：
 *   - 空：虚线浅色，"还没开始用，欢迎点开"的感觉
 *   - 非空：amber 实色填充，"这里有内容，点开看"
 */
function GoodEpisodesChip({
  episodes, onOpen,
}: {
  episodes: number[]
  onOpen: () => void
}): JSX.Element {
  const isEmpty = episodes.length === 0
  return (
    <button
      type="button"
      onClick={onOpen}
      title={
        isEmpty
          ? '标记这部番里的好看集（重温有关注点 / 重看片段 / 暂停截图）'
          : `✨ 已标 ${episodes.length} 集好看集 — 点击查看 / 编辑`
      }
      className={
        isEmpty
          ? 'inline-flex items-center gap-1 h-7 px-2 rounded-md bg-surface border border-dashed border-outline-variant/30 hover:border-amber-400/50 hover:bg-amber-400/8 text-on-surface-variant/55 hover:text-amber-600 font-label text-[10px] uppercase tracking-widest transition-colors'
          : 'inline-flex items-center gap-1 h-7 px-2 rounded-md bg-amber-400/15 border border-amber-400/40 hover:bg-amber-400/25 hover:border-amber-400/60 text-amber-600 font-label text-[10px] uppercase tracking-widest transition-colors'
      }
    >
      <span
        className="material-symbols-outlined leading-none"
        style={{ fontSize: 13, fontVariationSettings: isEmpty ? "'FILL' 0" : "'FILL' 1" }}
      >
        auto_awesome
      </span>
      <span>标好看集</span>
    </button>
  )
}

// ── Favorite stars ───────────────────────────────────────────────────────────

/**
 * 最爱值星级评分（B 站风格）—— 6 颗星位，点亮 N 颗代表 value=N。
 *
 * 交互：
 *   - 鼠标 hover 一颗星 → 整条预览到那颗为止的亮色（不写 store）
 *   - 点击星 N：
 *     · 若 value 已经是 N（即"再点一次同一颗"），清零回 0；
 *     · 否则 value 设为 N。
 *   这样单击既能"设到 N"，又能"清零"，不需要额外的清除按钮。
 *
 * 视觉：填充星用 amber-400 / 空星 outline，hover 预览跟最终态颜色一致避免
 * 用户被颜色变化吓到。
 */
function FavoriteStars({
  value, onChange,
}: {
  value: number
  onChange: (n: number) => void
}): JSX.Element {
  const [preview, setPreview] = useState<number | null>(null)
  const shown = preview ?? value
  return (
    <div
      className="inline-flex items-center gap-0.5"
      onMouseLeave={() => setPreview(null)}
      title={value > 0 ? `最爱值 ${value}/6（点同一颗清零）` : '点星设最爱值'}
    >
      {Array.from({ length: 6 }, (_, i) => {
        const n = i + 1
        const filled = n <= shown
        return (
          <button
            key={n}
            type="button"
            onMouseEnter={() => setPreview(n)}
            onClick={() => onChange(value === n ? 0 : n)}
            className={`w-5 h-5 flex items-center justify-center transition-colors ${
              filled ? 'text-amber-400' : 'text-on-surface-variant/25 hover:text-amber-400/50'
            }`}
            aria-label={`设置最爱值 ${n}`}
          >
            <span
              className="material-symbols-outlined leading-none"
              style={{ fontSize: 16, fontVariationSettings: filled ? "'FILL' 1" : "'FILL' 0" }}
            >
              star
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ── Observe counter ──────────────────────────────────────────────────────────

/**
 * 观望次数计数器 —— 替代观望状态下的 🌟 评分槽。
 *
 * 设计意图：原 PDF 里观望次数 > 3 时用户会自己手动迁到"在追"。这里把"次数"
 * 当作头等数据展示（不是星级评分），用 −/数字/+ 三键编辑；≥4 时数字框换
 * 主色 border + 主色字 + tooltip 提示升级，**不**长出额外按钮 —— 升级动作
 * 走左侧已有的 StatusSegment（点"在追"即可），避免功能冗余。
 *
 * 视觉对齐 `EpisodeCounter` 的 −/+1 规格（w-7 h-7 圆角 + border），保证一行
 * 里两组 −/+ 控件视觉协调，不会出现"一组明显一组隐形"的违和感。
 *
 * 不设上限：用户硬要继续观望 N>4 不阻止，UI 持续主色高亮。这跟「最爱值」
 * clamp 到 [0,6] 的硬上限是有意区分的 —— 观望次数是行为统计，最爱值是评分。
 */
function ObserveCounter({
  value, onChange,
}: {
  value: number
  onChange: (n: number) => void
}): JSX.Element {
  const overThreshold = value >= 4
  const title = overThreshold
    ? `观望 ${value} 次（> 3，可在左侧 status 切到「在追」）`
    : `观望 ${value} 次（点 −/+ 调整；>3 时考虑切到「在追」）`
  return (
    <div className="inline-flex items-center gap-1.5" title={title}>
      <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/45">
        观望
      </span>
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={value <= 0}
        title="观望次数 −1"
        className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-high transition-colors disabled:opacity-30 disabled:cursor-not-allowed border border-outline-variant/15"
      >
        <span className="material-symbols-outlined text-[16px] leading-none">remove</span>
      </button>
      {/* 数字框尺寸 / border 对齐 EpisodeInput；≥4 切主色，UI 提示该升级。 */}
      <div className={`min-w-[2rem] h-7 px-2 rounded-md flex items-center justify-center font-mono text-xs font-bold tabular-nums border transition-colors ${
        overThreshold
          ? 'border-primary/40 text-primary bg-primary/8'
          : 'border-outline-variant/15 text-on-surface bg-surface'
      }`}>
        {value}
      </div>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        title="观望次数 +1"
        className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-high transition-colors border border-outline-variant/15"
      >
        <span className="material-symbols-outlined text-[16px] leading-none">add</span>
      </button>
    </div>
  )
}

// ── Empty states ─────────────────────────────────────────────────────────────

function EmptyAll(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-32 gap-6 text-on-surface-variant/30">
      <span className="material-symbols-outlined text-6xl">bookmarks</span>
      <div className="text-center max-w-md">
        <p className="font-headline text-base text-on-surface/60 font-bold mb-1">这里还空着</p>
        <p className="font-body text-xs leading-relaxed">
          去 <span className="text-primary/80">Anime Info</span> 搜一部番，详情页左栏点
          <span className="inline-flex items-center gap-1 mx-1 text-on-surface/60">
            <span className="material-symbols-outlined text-[14px] leading-none align-text-bottom">bookmark_add</span>
            <span className="font-bold">Track this anime</span>
          </span>
          就会出现在这里。
        </p>
      </div>
    </div>
  )
}

function EmptyFiltered({ hasQuery, statusLabel }: { hasQuery: boolean; statusLabel: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-on-surface-variant/30">
      <span className="material-symbols-outlined text-5xl">search_off</span>
      <p className="font-label text-xs uppercase tracking-widest">
        {hasQuery && statusLabel ? `「${statusLabel}」里没有匹配项` :
         hasQuery ? '没有匹配的追番' :
         statusLabel ? `「${statusLabel}」里还没有番` :
         '没有结果'}
      </p>
    </div>
  )
}
