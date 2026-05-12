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
// - WebDAV sync isn't owned here — HomeworkLookup's shared blob picks `tracks`
//   up alongside homework/jjc/pjjc/classic/log (see `_v=5` migration there).
// - 备注字段在 store 里仍保留（向后兼容老数据），但不再有 UI 入口。

import { useMemo, useState } from 'react'
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
  { key: 'watching',  label: '在追',  icon: 'play_arrow',  color: 'text-primary',   tint: 'bg-primary/10',   border: 'border-primary/30' },
  { key: 'plan',      label: '想看',  icon: 'visibility',  color: 'text-secondary', tint: 'bg-secondary/10', border: 'border-secondary/30' },
  { key: 'completed', label: '看完',  icon: 'check_circle', color: 'text-tertiary',  tint: 'bg-tertiary/10',  border: 'border-tertiary/30' },
  { key: 'paused',    label: '暂停',  icon: 'pause',       color: 'text-outline',   tint: 'bg-outline/10',   border: 'border-outline/30' },
  { key: 'dropped',   label: '弃番',  icon: 'close',       color: 'text-error',     tint: 'bg-error/10',     border: 'border-error/30' },
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

// ── Top-level page ───────────────────────────────────────────────────────────

type FilterKey = 'all' | AnimeStatus

export default function MyAnime(): JSX.Element {
  const tracks = useAnimeTrackList()
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')

  // 不按 updatedAt 排序 —— animeTrackStore.list() 已经是 Map 的插入顺序
  // （= 用户加入追番的顺序）。编辑某条 track 不会动它的位置，避免每次改
  // 进度 / 状态都被弹到顶部那种"邮件式 reorder"的吵闹感。
  const filtered = useMemo(() => {
    const byQ = tracks.filter(t => matchesAnime(t, query.trim()))
    return filter === 'all' ? byQ : byQ.filter(t => t.status === filter)
  }, [tracks, filter, query])

  // Counts include search-narrowed scope so the badges reflect what would
  // actually appear if the user clicked into each bucket.
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, watching: 0, plan: 0, completed: 0, paused: 0, dropped: 0 }
    for (const t of tracks) {
      if (!matchesAnime(t, query.trim())) continue
      c.all++
      c[t.status]++
    }
    return c
  }, [tracks, query])

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="搜索追番标题、别名、备注…" onSearch={setQuery} />

      <div className="pt-16">
        {/* Sticky header */}
        <div className="sticky top-0 z-30 bg-surface-container-lowest border-b border-outline-variant/10 px-8 py-5">
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
            </div>
          </div>

          {/* Filter chips */}
          <div className="mt-4 inline-flex bg-surface-container rounded-lg p-1 border border-outline-variant/15 gap-1">
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
          </div>
        </div>

        {/* Body */}
        {tracks.length === 0 ? (
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
      </div>
    </div>
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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [addingBinding, setAddingBinding] = useState(false)
  // 当前正在补搜的内置源；null = 没在搜
  const [searchingSource, setSearchingSource] = useState<Source | null>(null)
  // 「编辑」按钮打开的弹窗 —— 弹窗里集中改用户手动加的链接（标题 / URL /
  // 删除），物理隔离日常的"点 chip 跳转"操作，杜绝误删。
  // 内置三源（Aowu/Xifan/Girigiri）不在弹窗里，它们走「+ 搜 X」流程管理。
  const [editingOpen, setEditingOpen] = useState(false)
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
              onClick={() => {
                if (confirmDelete) {
                  animeTrackStore.delete(track.bgmId)
                } else {
                  setConfirmDelete(true)
                  setTimeout(() => setConfirmDelete(false), 2500)
                }
              }}
              title={confirmDelete ? '再点一次确认移除' : '从追番列表移除'}
              className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                confirmDelete
                  ? 'text-error bg-error/15'
                  : 'text-on-surface-variant/50 hover:text-error hover:bg-error/10'
              }`}
            >
              <span
                className="material-symbols-outlined text-[16px] leading-none"
                style={{ fontVariationSettings: confirmDelete ? "'FILL' 1" : "'FILL' 0" }}
              >
                {confirmDelete ? 'delete_forever' : 'delete'}
              </span>
            </button>
          </div>
        </div>

        {/* Status + episode counter row */}
        <div className="flex items-center gap-4 flex-wrap">
          <StatusSegment current={track.status} onChange={setStatus} />
          <EpisodeCounter
            episode={track.episode}
            total={track.totalEpisodes}
            onChange={setEpisode}
            onTotalChange={setTotalEpisodes}
          />
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
      // 清空 = 重置为未知
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
      {/* 总集数也可编辑 —— BGM eps=0 显示成 "?" 时，用户点 "?" 自己输入
          一个目标值。留空提交 = 重置回 "?"。 */}
      <input
        type="text"
        inputMode="numeric"
        value={totalDisplay}
        onChange={e => setTotalDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onFocus={() => setTotalDraft(total != null ? String(total) : '')}
        onBlur={commitTotal}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.currentTarget.blur() }
          if (e.key === 'Escape') { setTotalDraft(null); e.currentTarget.blur() }
        }}
        placeholder="?"
        title={total == null ? '点这里填总集数（留空保持未知）' : '改总集数'}
        className="w-7 bg-transparent outline-none text-center text-on-surface-variant/70 hover:text-on-surface focus:text-on-surface placeholder:text-on-surface-variant/40"
      />
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
