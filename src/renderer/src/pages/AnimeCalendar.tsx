// 番剧周历 — week-at-a-glance of what's currently airing, fetched from BGM.
//
// Layout: 7-day grid (Mon-Sun in BGM order), one column per weekday, anime
// cards stacked inside. Each card shows cover + title + a "Track" hover
// affordance so the user can fold this week's interesting shows into their
// list without leaving the page.
//
// The main process owns the 24h disk cache; this page just renders whatever
// it gets back. Calling refresh forces an update path via `update=true`.

import { useEffect, useMemo, useState } from 'react'
import TopBar from '../components/TopBar'
import ErrorPanel from '../components/ErrorPanel'
import type { BgmCalendarItem, BgmCalendarResult } from '../types/bgm'
import {
  animeTrackStore,
  useAnimeTrack,
} from '../stores/animeTrackStore'
import { WatchHere } from '../components/WatchHere'

type State =
  | { status: 'loading' }
  | { status: 'ready'; result: BgmCalendarResult }
  | { status: 'error'; message: string }

// ── Module-level cache so navigating away and back doesn't re-spin ──────────

let _cachedState: State = { status: 'loading' }

export default function AnimeCalendar(): JSX.Element {
  const [state, setState] = useState<State>(_cachedState)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    _cachedState = state
  }, [state])

  const load = async (update = false): Promise<void> => {
    if (update) setRefreshing(true)
    else if (state.status !== 'ready') setState({ status: 'loading' })
    try {
      const result = await window.bgmApi.calendar(update)
      setState({ status: 'ready', result })
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (state.status !== 'ready') void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="搜索本周番剧..." />
      <div className="pt-16">
        {/* Hero — 标题块随内容滚走，不 sticky。 */}
        <div className="px-8 pt-5 pb-3">
          <div className="flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>calendar_month</span>
            <span>Anime</span>
            <span className="text-outline-variant">/</span>
            <span className="text-on-surface font-bold">番剧周历</span>
          </div>
          <h1 className="text-3xl font-black tracking-tighter text-on-surface">番剧周历</h1>
          <p className="text-sm text-on-surface-variant/80 mt-1 font-label">
            本季正在播出，按星期排列。来源 Bangumi · 14 天缓存。
          </p>
        </div>

        {/* 真正的置顶栏：周一-周日 chip 行 + 缓存/刷新小工具栏。
            top-16 紧贴 TopBar；用户滚下去能始终看到周几对应哪列以及刷新。

            两行结构：
              Row 1: 缓存时间 + 刷新按钮，右对齐，紧凑（高度约 22px）
              Row 2: 7 chip grid-cols-7，和下方 cards grid-cols-7 共享同一份
                     容器宽度（都是 px-6 + 完整宽度），column 对 column 严丝
                     合缝。一行结构（刷新挤在右侧）会让 chip flex-1 比 cards
                     窄出一截，造成"周日 chip 在卡片的左边"的视觉错位。 */}
        {state.status === 'ready' && (
          <div className="sticky top-16 z-30 bg-surface-container-lowest border-y border-outline-variant/10 px-6 pt-1.5 pb-2">
            <div className="flex items-center justify-end gap-2 mb-1.5 h-5">
              <span className="font-label text-[10px] text-on-surface-variant/50 tracking-wider whitespace-nowrap">
                {state.result.fromCache ? '缓存：' : '刚拉取：'}
                {formatRelTime(state.result.updatedAt)}
              </span>
              <button
                onClick={() => void load(true)}
                disabled={refreshing}
                title="强制刷新（绕过 14 天缓存）"
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-surface-container-high border border-outline-variant/20 hover:bg-primary/10 hover:border-primary/30 hover:text-primary font-label text-[10px] uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span
                  className={`material-symbols-outlined leading-none ${refreshing ? 'animate-spin' : ''}`}
                  style={{ fontSize: 12 }}
                >
                  refresh
                </span>
                <span>{refreshing ? '更新中' : '刷新'}</span>
              </button>
            </div>
            <DayChipsBar result={state.result} />
          </div>
        )}

        {state.status === 'loading' && <LoadingState />}
        {state.status === 'error' && (
          <ErrorPanel error={state.message} onRetry={() => void load(true)} />
        )}
        {state.status === 'ready' && <CalendarGrid result={state.result} />}
      </div>
    </div>
  )
}

// ── Day chips bar ────────────────────────────────────────────────────────────
// 7 day chips on a single grid row. Sticks at top-16 with the refresh cluster.
// Uses grid-cols-7 to align column-by-column with the cards grid below.

function DayChipsBar({ result }: { result: BgmCalendarResult }): JSX.Element {
  const todayBgmId = useMemo(() => {
    const d = new Date().getDay() // 0..6
    return d === 0 ? 7 : d
  }, [])
  return (
    // grid-cols-7 + gap-3，和 CalendarGrid 完全同结构；外层 px-6 也一致,
    // 所以 chip N 的左右边和 card column N 的左右边逐像素对齐。
    <div className="grid grid-cols-7 gap-3 min-w-0">
      {result.data.map(day => {
        const active = day.id === todayBgmId
        return (
          <div
            key={day.id}
            className={`px-2.5 py-1.5 rounded-md border flex items-baseline justify-between gap-2 ${
              active
                ? 'bg-primary/12 border-primary/30 text-primary'
                : 'bg-surface-container border-outline-variant/15 text-on-surface-variant/80'
            }`}
          >
            <span className="font-headline text-xs font-black tracking-tight">{day.label}</span>
            <span className="font-label text-[10px] uppercase tracking-widest opacity-60">
              {day.items.length} 部
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Grid ─────────────────────────────────────────────────────────────────────

function CalendarGrid({ result }: { result: BgmCalendarResult }): JSX.Element {
  if (result.data.every(d => d.items.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4 text-on-surface-variant/30">
        <span className="material-symbols-outlined text-6xl">event_busy</span>
        <p className="font-label text-xs uppercase tracking-widest">本周没有数据</p>
      </div>
    )
  }

  return (
    // grid-cols-7 自适应容器宽度 —— 默认 1280px 窗口（content ≈ 1024px）能
    // 完整装下 7 列；用户调小窗口卡片随之变小，不会出现横向滚动。
    // 周一-周日 chip 行已经移到上方 sticky bar 里，DayColumn 只保留卡片堆。
    <div className="px-6 py-3 grid grid-cols-7 gap-3">
      {result.data.map(day => (
        <DayColumn key={day.id} day={day} />
      ))}
    </div>
  )
}

function DayColumn({
  day,
}: { day: { id: number; label: string; items: BgmCalendarItem[] } }): JSX.Element {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      {day.items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-outline-variant/20 px-3 py-6 text-center font-label text-[10px] text-on-surface-variant/30 uppercase tracking-widest">
          空
        </div>
      ) : (
        day.items.map(item => <CalendarCard key={item.id} item={item} />)
      )}
    </div>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────

function CalendarCard({ item }: { item: BgmCalendarItem }): JSX.Element {
  const track = useAnimeTrack(item.id)
  const displayTitle = item.name_cn || item.name
  const sub = item.name_cn && item.name && item.name !== item.name_cn ? item.name : ''

  const toggleTrack = (): void => {
    if (track) {
      animeTrackStore.delete(item.id)
    } else {
      // 立即 upsert，UI 即时响应（按钮立刻翻成"已追番"状态）。
      // BgmCalendarItem 不带 tags 字段，所以 bgmTags 会落成 [] —— 紧接着
      // 后台异步 fetch detail 把 BGM 标签快照补上（lock-on-first-content
      // 保证补写不会污染用户已看过的快照）。
      animeTrackStore.upsert({
        bgmId: item.id,
        title: item.name,
        titleCn: item.name_cn || undefined,
        cover: item.cover || undefined,
        totalEpisodes: item.episodes > 0 ? item.episodes : undefined,
        status: 'watching',
        episode: 0,
      })
      void animeTrackStore.ensureBgmTagsFilled(item.id)
    }
  }

  return (
    <div className="group relative bg-surface-container rounded-lg border border-outline-variant/15 overflow-hidden hover:border-primary/30 transition-colors">
      <div className="aspect-[3/4] relative">
        {item.cover ? (
          <img
            src={item.cover}
            alt={displayTitle}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-surface-container-high text-on-surface-variant/20">
            <span className="material-symbols-outlined text-3xl">image</span>
          </div>
        )}

        {/* Tracking badge — visible always when bound. */}
        {track && (
          <div
            className="absolute top-1.5 left-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-primary-container/85 backdrop-blur-sm border border-primary/30 text-on-primary-container shadow-sm"
            title={`${track.status} · ep ${track.episode}${track.totalEpisodes ? `/${track.totalEpisodes}` : ''}`}
          >
            <span
              className="material-symbols-outlined leading-none"
              style={{ fontSize: 10, fontVariationSettings: "'FILL' 1" }}
            >
              bookmark
            </span>
            <span className="font-label text-[9px] font-bold tracking-wider">
              {track.episode > 0 ? `EP ${track.episode}` : '在追'}
            </span>
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2 gap-1.5">
          <button
            onClick={toggleTrack}
            className={`w-full text-[10px] font-label tracking-widest uppercase py-1.5 rounded-md flex items-center justify-center gap-1 transition-colors ${
              track
                ? 'bg-error/20 hover:bg-error/30 text-error border border-error/30'
                : 'bg-primary/85 hover:bg-primary text-on-primary border border-primary'
            }`}
          >
            <span
              className="material-symbols-outlined leading-none"
              style={{ fontSize: 12, fontVariationSettings: track ? "'FILL' 1" : "'FILL' 0" }}
            >
              {track ? 'bookmark_remove' : 'bookmark_add'}
            </span>
            <span>{track ? '取消' : '追番'}</span>
          </button>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            title="在 Bangumi 查看"
            className="w-full text-[10px] font-label tracking-widest uppercase py-1.5 rounded-md flex items-center justify-center gap-1 bg-surface-container-highest/85 backdrop-blur-sm hover:bg-surface-container-highest text-on-surface-variant border border-outline-variant/30 transition-colors"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>open_in_new</span>
            <span>BGM</span>
          </a>
        </div>
      </div>

      {/* 信息区精确固定高度（用 h-* 而非 min-h-*），保证所有卡片高度一致：
          - 标题 h-[30px] = text-xs 12px × leading-tight 1.25 × 2 行
          - sub h-[14px] ≈ 10px × 1.25 × 1 行（无 sub 时空格占位防塌陷）
          - meta 行 h-[12px] 始终渲染，score/eps 缺值时占位空字符串
          WatchHere chips 仅在已绑过源时出现，calendar 里这种卡是少数；
          多出来的高度等同于"这部已追"的视觉信号，不强求对齐。 */}
      <div className="px-2 py-2 flex flex-col gap-0.5">
        <h3
          className="text-xs font-bold text-on-surface line-clamp-2 leading-tight h-[30px]"
          title={displayTitle}
        >
          {displayTitle}
        </h3>
        <p
          className="text-[10px] text-on-surface-variant/40 line-clamp-1 leading-tight h-[14px]"
          title={sub || undefined}
        >
          {sub || ' '}
        </p>
        <div className="flex items-center justify-between gap-1 h-[12px]">
          <span className="font-label text-[9px] text-primary/70 leading-none">
            {item.score > 0 ? `★ ${item.score.toFixed(1)}` : ''}
          </span>
          <span className="font-label text-[9px] text-on-surface-variant/40 tracking-wider leading-none">
            {item.episodes > 0 ? `${item.episodes} eps` : ''}
          </span>
        </div>
        <div className="mt-0.5">
          <WatchHere bgmId={item.id} variant="inline" />
        </div>
      </div>
    </div>
  )
}

// ── Loading ──────────────────────────────────────────────────────────────────

function LoadingState(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-32 gap-4">
      <span
        className="material-symbols-outlined text-primary/60 text-4xl animate-spin"
        style={{ animationDuration: '1.2s' }}
      >
        progress_activity
      </span>
      <p className="font-label text-xs text-on-surface-variant/40 tracking-widest uppercase">
        Loading calendar...
      </p>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
