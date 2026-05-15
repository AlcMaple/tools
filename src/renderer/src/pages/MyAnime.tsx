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

import { useEffect, useMemo, useState } from 'react'
import TopBar from '../components/TopBar'
import {
  animeTrackStore,
  useAnimeTrackList,
  type AnimeStatus,
  type AnimeTrack,
} from '../stores/animeTrackStore'
import { WatchHere } from '../components/WatchHere'
import { AddBindingModal } from '../components/AddBindingModal'
import { SearchSourceModal } from '../components/SearchSourceModal'
import { AnimeSyncBar } from '../components/AnimeSyncBar'
import {
  RecommendationView,
  REC_STATUS_META,
  countRecsByStatus,
  type RecFilterKey,
} from '../components/RecommendationView'
import { useRecommendationList } from '../stores/recommendationStore'
import { QuickRecommendModal } from '../components/QuickRecommendModal'
import { NewRecommendationModal } from '../components/NewRecommendationModal'
import { CriteriaModal } from '../components/CriteriaModal'
import { GoodEpisodesEditor } from '../components/GoodEpisodesEditor'
import { TagFilter } from '../components/TagFilter'
import { UserTagsEditor } from '../components/UserTagsEditor'
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
  const hay = [t.title, t.titleCn ?? '', t.bindings.map(b => b.sourceTitle).join(' ')]
    .join(' ')
    .toLowerCase()
  return hay.includes(needle)
}

/**
 * Tag 过滤 —— AND 语义：每个 selected tag 都必须在 track 的 (bgmTags ∪ userTags)
 * 集合里。selected 为空数组就直接放行（不过滤）。
 *
 * 大小写敏感、完全匹配——这跟字符串模糊搜索不同，tag 是离散值，模糊匹配会
 * 让 "恋爱" 和 "恋爱漫" 互相误中，所以这里用严格 equality。
 */
function matchesTags(t: AnimeTrack, selectedTags: string[]): boolean {
  if (selectedTags.length === 0) return true
  const trackTags = new Set([...t.bgmTags, ...t.userTags])
  return selectedTags.every(tag => trackTags.has(tag))
}

// ── Top-level page ───────────────────────────────────────────────────────────

type FilterKey = 'all' | AnimeStatus
type SortKey = 'addedDesc' | 'favoriteDesc'
type Tab = 'tracks' | 'recommendations'

const SORT_KEY = 'maple-anime-sort'
const TAB_KEY = 'maple-anime-tab'

export default function MyAnime(): JSX.Element {
  const tracks = useAnimeTrackList()
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>(() => {
    const v = localStorage.getItem(SORT_KEY)
    return v === 'favoriteDesc' ? 'favoriteDesc' : 'addedDesc'
  })
  useEffect(() => { localStorage.setItem(SORT_KEY, sort) }, [sort])
  // 顶层 tab：tracks 追番列表 / recommendations 推荐管理。
  // 默认 tracks（用户大部分时间在这），切换时持久化，下次进来还在原 tab。
  const [tab, setTab] = useState<Tab>(() => {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'recommendations' ? 'recommendations' : 'tracks'
  })
  useEffect(() => { localStorage.setItem(TAB_KEY, tab) }, [tab])
  // 推荐 tab 的过滤状态 + 新建弹窗状态 —— 提到这里是为了让 sticky header
  // 跟追番 tab 结构一致（chips 在容器外，body 只是列表）。
  const [recFilter, setRecFilter] = useState<RecFilterKey>('all')
  const [newRecOpen, setNewRecOpen] = useState(false)
  const recs = useRecommendationList()
  const recCounts = useMemo(() => countRecsByStatus(recs), [recs])
  // 评判标准弹窗：给 ✨ 好看集 和 🌟 最爱值 提供"什么时候 +1"的参考文档。
  // 入口是 sticky header 标题旁的 help_outline 图标。两个 tab 都能打开（最爱
  // 值在追番 tab 直接相关，但用户可能在推荐 tab 想起来要查标准，所以保持常驻）。
  const [criteriaOpen, setCriteriaOpen] = useState(false)
  // 类型过滤 —— sticky header row 3 的「类型」按钮选中的 tag 集合，AND 语义
  // （详见 matchesTags）。仅追番 tab 用；切到推荐 tab 时仍保留 state，回切
  // 不丢用户的过滤选择。
  const [selectedTags, setSelectedTags] = useState<string[]>([])

  // 排序：
  //   - addedDesc（默认）：按添加顺序倒序——最新追的排顶部。
  //     animeTrackStore.list() 是 Map 的插入顺序（老的在前），reverse 让
  //     最新的到顶。编辑行不会改位置（upsert 的 map.set 对已有 key 保持
  //     插入位置不变），避免"改进度被弹到顶部"的吵闹感。
  //   - favoriteDesc：按 🌟 数从高到低。同 🌟 数的按添加倒序作 tie-breaker。
  // 只在显示层做排序，store 本身仍按插入顺序持久化 —— 不动 AnimeSyncBar 的
  // snapshot diff 与 WebDAV blob 格式。
  const filtered = useMemo(() => {
    const byQ = tracks.filter(t => matchesAnime(t, query.trim()))
    const byTags = byQ.filter(t => matchesTags(t, selectedTags))
    const inFilter = filter === 'all' ? byTags : byTags.filter(t => t.status === filter)
    const reversed = [...inFilter].reverse()
    if (sort === 'favoriteDesc') {
      // stable sort：JS Array.prototype.sort 是稳定的（ES2019+），同
      // favorite 时保持 reversed 给的添加倒序。
      reversed.sort((a, b) => b.favorite - a.favorite)
    }
    return reversed
  }, [tracks, filter, query, sort, selectedTags])

  // Counts include search-narrowed + tag-filtered scope so the badges reflect
  // what would actually appear if the user clicked into each bucket.
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, watching: 0, plan: 0, considering: 0, completed: 0 }
    for (const t of tracks) {
      if (!matchesAnime(t, query.trim())) continue
      if (!matchesTags(t, selectedTags)) continue
      c.all++
      c[t.status]++
    }
    return c
  }, [tracks, query, selectedTags])

  // 全部 tag 聚合 + 命中数 —— 给 TagFilter popover 用的输入。
  // bgmTags ∪ userTags（每个 track 里去重），跨 track 聚合后按命中数倒序。
  // 这里不应用 query / status / selectedTags 过滤——popover 是"全集"视图,
  // 让用户能看到自己还没选的 tag；过滤了反而让 popover 变成"已选 tag 子集"
  // 没法发现其他选项。
  const allTagsWithCount = useMemo(() => {
    const counter = new Map<string, number>()
    for (const t of tracks) {
      const trackTags = new Set([...t.bgmTags, ...t.userTags])
      for (const tag of trackTags) {
        counter.set(tag, (counter.get(tag) ?? 0) + 1)
      }
    }
    return [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }, [tracks])

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="搜索追番标题、别名、备注…" onSearch={setQuery} />

      <div className="pt-16">
        {/* Sticky header —— top-16 是为了让自己卡在 fixed TopBar（高 64px = pt-16）
            下面，不是 top-0（会让标题被 TopBar 压住露出一半）。 */}
        <div className="sticky top-16 z-30 bg-surface-container-lowest border-b border-outline-variant/10 px-8 py-5">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>bookmark</span>
                <span>Anime</span>
                <span className="text-outline-variant">/</span>
                <span className="text-on-surface font-bold">我的追番</span>
              </div>
              <h1 className="text-3xl font-black tracking-tighter text-on-surface">我的追番</h1>
              <p className="text-sm text-on-surface-variant/80 mt-1 font-label">
                状态 · 集数 · 备注 全在这里。在 BGM 详情页加进来，回到这里管理进度。
              </p>
            </div>

            <div className="flex items-center gap-3">
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

              {/* 搜索框只在追番 tab 出现 —— 它对推荐 tab 没意义；推荐 tab 的过滤是
                  「待回应 / 已接受 / 已拒绝」chips，由 RecommendationView 自带 */}
              {tab === 'tracks' && (
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-base">search</span>
                  <input
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    className="w-[320px] bg-surface-container-high border border-outline-variant/20 rounded-xl py-2.5 pl-10 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/40 focus:bg-surface-bright transition-all placeholder:text-on-surface-variant/40"
                    placeholder="搜索追番标题、别名、备注…"
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
              )}
            </div>
          </div>

          {/* Tab 导航行 —— 顶级切换「追番列表 / 推荐」。
              AnimeSyncBar 永远跟着这一行（追番和推荐共用 anime.json blob 同步,
              两个 tab 都能看到同步状态、点上传/下载）。 */}
          <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="inline-flex bg-surface-container rounded-lg p-1 border border-outline-variant/15 gap-1">
              <TabButton
                active={tab === 'tracks'}
                onClick={() => setTab('tracks')}
                icon="bookmark"
                label="追番列表"
                count={tracks.length}
              />
              <TabButton
                active={tab === 'recommendations'}
                onClick={() => setTab('recommendations')}
                icon="campaign"
                label="推荐"
              />
            </div>
            <AnimeSyncBar />
          </div>

          {/* 过滤 chips 行 —— 两个 tab 共用同一行位置，内容根据 tab 切换。
              这样 sticky header 视觉结构稳定，tab 切换时不会出现"chips 跳进
              body 容器"那种突兀。右侧附件也根据 tab 切：追番 → 排序切换；
              推荐 → 新建按钮。 */}
          <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="inline-flex bg-surface-container rounded-lg p-1 border border-outline-variant/15 gap-1">
              {tab === 'tracks' ? (
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
            {tab === 'tracks' ? (
              <div className="flex items-center gap-2 flex-wrap">
                {/* 类型过滤器 —— 比 SortSelector 高度优先,放它左边对齐 */}
                <TagFilter
                  allTags={allTagsWithCount}
                  selected={selectedTags}
                  onChange={setSelectedTags}
                />
                <SortSelector value={sort} onChange={setSort} />
              </div>
            ) : (
              <button
                onClick={() => setNewRecOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary/15 text-primary border border-primary/25 font-label text-xs font-bold tracking-widest uppercase hover:bg-primary/25 transition-all"
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>add</span>
                新建推荐
              </button>
            )}
          </div>

          {/* Row 4：已选 tag chip 行 —— 只在 tracks tab + 有选中 tag 时出现。
              让"我现在按什么过滤"在 sticky header 永远可见，不滚也能改。
              chip 点击 = 移除该 tag（跟 popover 里 toggle 同一心智）。 */}
          {tab === 'tracks' && selectedTags.length > 0 && (
            <div className="mt-3 flex items-center gap-1.5 flex-wrap">
              <span className="font-label text-[10px] text-on-surface-variant/45 uppercase tracking-widest mr-1">
                已按 类型 过滤
              </span>
              {selectedTags.map(tag => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setSelectedTags(prev => prev.filter(t => t !== tag))}
                  title={`移除「${tag}」过滤`}
                  className="group inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary/12 border border-primary/25 text-primary hover:bg-error/15 hover:border-error/30 hover:text-error font-label text-[10px] font-bold tracking-wider transition-colors"
                >
                  <span>{tag}</span>
                  <span
                    className="material-symbols-outlined leading-none"
                    style={{ fontSize: 12 }}
                  >
                    close
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setSelectedTags([])}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-on-surface-variant/55 hover:text-on-surface font-label text-[10px] uppercase tracking-widest transition-colors"
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>backspace</span>
                <span>清空</span>
              </button>
            </div>
          )}
        </div>

        {/* Body —— 按 tab 切换 */}
        {tab === 'recommendations' ? (
          <RecommendationView filter={recFilter} />
        ) : tracks.length === 0 ? (
          <EmptyAll />
        ) : filtered.length === 0 ? (
          <EmptyFiltered hasQuery={!!query.trim()} statusLabel={filter === 'all' ? '' : statusMetaOf(filter).label} />
        ) : (
          <div className="px-8 py-6 space-y-3">
            {filtered.map(t => (
              <TrackRow key={t.bgmId} track={t} />
            ))}
          </div>
        )}

        {/* 新建推荐弹窗（推荐 tab 顶部按钮触发） */}
        {newRecOpen && (
          <NewRecommendationModal onClose={() => setNewRecOpen(false)} />
        )}

        {/* 评判标准弹窗（标题旁帮助按钮触发） */}
        {criteriaOpen && (
          <CriteriaModal onClose={() => setCriteriaOpen(false)} />
        )}
      </div>
    </div>
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
          ? 'bg-primary/15 text-primary border-primary/25 font-bold'
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
      {count !== undefined && (
        <span className={`font-label text-[10px] ${active ? '' : 'text-on-surface-variant/40'}`}>{count}</span>
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
      <span className={`font-label text-[10px] ${active ? '' : 'text-on-surface-variant/40'}`}>{count}</span>
    </button>
  )
}

// ── Track row ────────────────────────────────────────────────────────────────

// 内置三源顺序固定：常驻显示在补绑按钮里，给"还没绑过"的源画虚线按钮。
// 其他来源（Bilibili / Custom）走 AddBindingModal 单独的「+ 添加链接」入口。
const BUILTIN_SOURCES: ReadonlyArray<Source> = ['Aowu', 'Xifan', 'Girigiri']

function TrackRow({ track }: { track: AnimeTrack }): JSX.Element {
  const displayTitle = track.titleCn || track.title
  const nativeTitle = track.titleCn && track.title !== track.titleCn ? track.title : ''
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
  // 「推荐」按钮打开的弹窗 —— 让用户只填"推荐给谁"，番剧信息直接复用本行。
  // 用户的洞察："推荐的番一定在追番列表里"，所以推荐入口设在 TrackRow 是最
  // 自然的——免去再做一遍 BGM 搜索。
  const [quickRecOpen, setQuickRecOpen] = useState(false)
  const userAddedBindings = track.bindings.filter(isUserAddedBinding)

  // 哪些内置源还没绑过 —— 已绑过的隐藏「+ 搜 X」按钮，留出空间。
  const boundSources = new Set(track.bindings.map(b => b.source))
  const missingBuiltins = BUILTIN_SOURCES.filter(s => !boundSources.has(s))

  const setStatus = (s: AnimeStatus): void => {
    animeTrackStore.upsert({ bgmId: track.bgmId, status: s })
  }
  const setEpisode = (ep: number): void => {
    const total = track.totalEpisodes
    const clamped = Math.max(0, total != null ? Math.min(ep, total) : ep)
    // Auto-bump to "completed" when the user hits the final episode — small
    // ergonomic win since the +1 click and "I'm done" intent overlap.
    const patch: Partial<AnimeTrack> & { bgmId: number } = { bgmId: track.bgmId, episode: clamped }
    if (total != null && clamped === total && track.status === 'watching') patch.status = 'completed'
    // Conversely: bumping past 0 from a 'plan' state implies "I started" — auto
    // move to watching.
    if (clamped > 0 && track.status === 'plan') patch.status = 'watching'
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
  // 好看集 setter —— 接 number[]（编辑器 modal 整批写回，已 normalize）。
  const setGoodEpisodes = (eps: number[]): void => {
    animeTrackStore.upsert({ bgmId: track.bgmId, goodEpisodes: eps })
  }
  const [goodEpsOpen, setGoodEpsOpen] = useState(false)
  // 自定义标签编辑弹窗 —— 行内 🏷 按钮触发，让用户管理 userTags。
  // 跟 AnimeInfo 的 Genre 区不冲突（那边只读，这边是写入入口）。
  const [tagsOpen, setTagsOpen] = useState(false)
  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden flex">
      {/* Cover */}
      <div className="w-[88px] shrink-0 bg-surface-container-high">
        {track.cover ? (
          <img
            src={track.cover}
            alt={displayTitle}
            className="w-full aspect-[2/3] object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full aspect-[2/3] flex items-center justify-center text-on-surface-variant/20">
            <span className="material-symbols-outlined text-2xl">image</span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 p-4 min-w-0 flex flex-col gap-3">
        {/* Title row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-on-surface truncate" title={displayTitle}>
              {displayTitle}
            </h3>
            {nativeTitle && (
              <p className="text-xs text-on-surface-variant/60 truncate mt-0.5" title={nativeTitle}>
                {nativeTitle}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <a
              href={`https://bgm.tv/subject/${track.bgmId}`}
              target="_blank"
              rel="noreferrer"
              title="在 Bangumi 上查看"
              className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px] leading-none">open_in_new</span>
            </a>
            <button
              onClick={() => setQuickRecOpen(true)}
              title="推荐这部番给某人"
              className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px] leading-none">campaign</span>
            </button>
            <button
              onClick={() => setTagsOpen(true)}
              title={
                track.userTags.length > 0
                  ? `自定义标签：${track.userTags.join('、')}（点击编辑）`
                  : '加自定义标签（下饭 / 通勤番 之类）'
              }
              className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                track.userTags.length > 0
                  ? 'text-primary hover:bg-primary/10'
                  : 'text-on-surface-variant/50 hover:text-primary hover:bg-primary/10'
              }`}
            >
              <span
                className="material-symbols-outlined text-[16px] leading-none"
                style={{ fontVariationSettings: track.userTags.length > 0 ? "'FILL' 1" : "'FILL' 0" }}
              >
                sell
              </span>
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
            - 🌟 Stars：点星位 N 设 favorite=N，点已亮的那颗清回 0。 */}
        <div className="flex items-center gap-4 flex-wrap">
          <StatusSegment current={track.status} onChange={setStatus} />
          <EpisodeCounter
            episode={track.episode}
            total={track.totalEpisodes}
            onChange={setEpisode}
            onTotalChange={setTotalEpisodes}
          />
          <div className="ml-auto flex items-center gap-3 flex-wrap">
            <GoodEpisodesChip
              episodes={track.goodEpisodes}
              onOpen={() => setGoodEpsOpen(true)}
            />
            <FavoriteStars value={track.favorite} onChange={setFavorite} />
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
          totalEpisodes={track.totalEpisodes}
          episode={track.episode}
          onChange={setGoodEpisodes}
          onClose={() => setGoodEpsOpen(false)}
        />
      )}

      {tagsOpen && (
        <UserTagsEditor
          track={track}
          onClose={() => setTagsOpen(false)}
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
    </div>
  )
}

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
            <span>{m.label}</span>
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
            : 'border-primary/30 text-primary bg-primary/10 hover:bg-primary/20 font-bold'
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
                ? 'bg-primary/15 text-primary font-bold'
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
          : 'inline-flex items-center gap-1 h-7 px-2 rounded-md bg-amber-400/15 border border-amber-400/40 hover:bg-amber-400/25 hover:border-amber-400/60 text-amber-600 font-label text-[10px] uppercase tracking-widest font-bold transition-colors'
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
