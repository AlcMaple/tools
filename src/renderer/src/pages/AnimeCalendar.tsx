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
        {/* Sticky header */}
        <div className="sticky top-0 z-30 bg-surface-container-lowest border-b border-outline-variant/10 px-8 py-5">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>calendar_month</span>
                <span>Anime</span>
                <span className="text-outline-variant">/</span>
                <span className="text-on-surface font-bold">番剧周历</span>
              </div>
              <h1 className="text-3xl font-black tracking-tighter text-on-surface">番剧周历</h1>
              <p className="text-sm text-on-surface-variant/80 mt-1 font-label">
                本季正在播出，按星期排列。来源 Bangumi · 24h 缓存。
              </p>
            </div>

            <div className="flex items-center gap-3">
              {state.status === 'ready' && (
                <span className="font-label text-[11px] text-on-surface-variant/50 tracking-wider">
                  {state.result.fromCache ? '缓存：' : '刚刚拉取：'}
                  {formatRelTime(state.result.updatedAt)}
                </span>
              )}
              <button
                onClick={() => void load(true)}
                disabled={refreshing || state.status === 'loading'}
                title="强制刷新（绕过 24h 缓存）"
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-surface-container-high border border-outline-variant/20 hover:bg-primary/10 hover:border-primary/30 hover:text-primary font-label text-xs uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span
                  className={`material-symbols-outlined leading-none ${refreshing ? 'animate-spin' : ''}`}
                  style={{ fontSize: 14 }}
                >
                  refresh
                </span>
                <span>{refreshing ? '更新中...' : '刷新'}</span>
              </button>
            </div>
          </div>
        </div>

        {state.status === 'loading' && <LoadingState />}
        {state.status === 'error' && (
          <ErrorPanel error={state.message} onRetry={() => void load(true)} />
        )}
        {state.status === 'ready' && <CalendarGrid result={state.result} />}
      </div>
    </div>
  )
}

// ── Grid ─────────────────────────────────────────────────────────────────────

function CalendarGrid({ result }: { result: BgmCalendarResult }): JSX.Element {
  // BGM orders Mon-Sun. We highlight "today" so the user's eye lands on the
  // relevant column on open. JS Date.getDay() returns 0=Sun, 1=Mon...; convert
  // to BGM's 1-7 (Mon-Sun) scheme.
  const todayBgmId = useMemo(() => {
    const d = new Date().getDay() // 0..6
    return d === 0 ? 7 : d
  }, [])

  if (result.data.every(d => d.items.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4 text-on-surface-variant/30">
        <span className="material-symbols-outlined text-6xl">event_busy</span>
        <p className="font-label text-xs uppercase tracking-widest">本周没有数据</p>
      </div>
    )
  }

  return (
    <div className="px-6 py-6 grid grid-cols-7 gap-3 min-w-[1100px]">
      {result.data.map(day => (
        <DayColumn key={day.id} day={day} isToday={day.id === todayBgmId} />
      ))}
    </div>
  )
}

function DayColumn({
  day, isToday,
}: { day: { id: number; label: string; items: BgmCalendarItem[] }; isToday: boolean }): JSX.Element {
  return (
    <div className="flex flex-col min-w-0">
      {/* Column header */}
      <div
        className={`sticky top-[148px] z-20 px-3 py-2 mb-2 rounded-lg border ${
          isToday
            ? 'bg-primary/12 border-primary/30 text-primary'
            : 'bg-surface-container border-outline-variant/15 text-on-surface-variant/80'
        }`}
      >
        <div className="flex items-baseline justify-between">
          <span className="font-headline text-sm font-black tracking-tight">
            {day.label}
          </span>
          <span className="font-label text-[10px] uppercase tracking-widest opacity-60">
            {day.items.length} 部
          </span>
        </div>
        {isToday && (
          <p className="font-label text-[9px] uppercase tracking-widest opacity-80 mt-0.5">today</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {day.items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-outline-variant/20 px-3 py-6 text-center font-label text-[10px] text-on-surface-variant/30 uppercase tracking-widest">
            空
          </div>
        ) : (
          day.items.map(item => <CalendarCard key={item.id} item={item} />)
        )}
      </div>
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
      animeTrackStore.upsert({
        bgmId: item.id,
        title: item.name,
        titleCn: item.name_cn || undefined,
        cover: item.cover || undefined,
        totalEpisodes: item.episodes > 0 ? item.episodes : undefined,
        status: 'watching',
        episode: 0,
      })
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

      <div className="px-2 py-2">
        <h3
          className="text-xs font-bold text-on-surface line-clamp-2 leading-tight"
          title={displayTitle}
        >
          {displayTitle}
        </h3>
        {sub && (
          <p className="text-[10px] text-on-surface-variant/40 line-clamp-1 mt-0.5" title={sub}>
            {sub}
          </p>
        )}
        <div className="flex items-center justify-between mt-1 gap-1">
          {item.score > 0 && (
            <span className="font-label text-[9px] text-primary/70">
              ★ {item.score.toFixed(1)}
            </span>
          )}
          {item.episodes > 0 && (
            <span className="font-label text-[9px] text-on-surface-variant/40 tracking-wider">
              {item.episodes} eps
            </span>
          )}
        </div>
        {/* 已关联的源跳转 chips —— 只在已追且有 bindings 时出现，没有 bindings
            时组件自身返回 null 不占位。 */}
        <div className="mt-1.5">
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
