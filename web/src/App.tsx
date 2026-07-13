import { useEffect, useMemo, useState } from 'react'
import type { CalendarItem, CalendarResult, CalendarWeekday } from './api'
import { fetchCalendar } from './api'
import { useIsCompact } from './useMediaQuery'
import { Icon, Spinner } from './Icon'

// 设计对齐 app 的 src/renderer/src/pages/AnimeCalendar.tsx：
//   - 桌面（≥1200px）：7 列整周一览，每列一个星期的海报卡堆叠
//   - 精简（<1200px）：选某天 + 该天番剧多列网格
// 网页版暂无「追番 / 播放」功能，海报 hover 遮罩先只放「BGM 查看」链接，
// 结构与观感照 app，追番 / 播放到对应里程碑再补进遮罩。

const SHORT_DAY: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }

function todayBgmId(): number {
  const d = new Date().getDay() // 0=周日..6=周六
  return d === 0 ? 7 : d
}

export default function App(): JSX.Element {
  const [result, setResult] = useState<CalendarResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const isCompact = useIsCompact()
  const [selectedDay, setSelectedDay] = useState(todayBgmId)

  const load = (force = false): void => {
    if (force) setRefreshing(true)
    else setLoading(true)
    setError(null)
    fetchCalendar(force)
      .then(setResult)
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }

  useEffect(() => load(), [])

  return (
    <div className="relative min-h-full bg-background">
      {/* Hero —— 面包屑 + 标题 + 副标题，随内容滚走。 */}
      <div className="px-4 md:px-8 pt-6 pb-3">
        <div className="mb-2 hidden items-center gap-2 font-label text-xs uppercase tracking-widest text-outline md:flex">
          <Icon name="calendar_month" size={14} />
          <span>Anime</span>
          <span className="text-outline-variant">/</span>
          <span className="font-bold text-on-surface">番剧周历</span>
        </div>
        <h1 className="text-2xl font-black tracking-tighter text-on-surface md:text-3xl">番剧周历</h1>
        <p className="mt-1 hidden font-label text-sm text-on-surface-variant/80 md:block">
          本季正在播出，按星期排列。来源 Bangumi · 14 天缓存。
        </p>
      </div>

      {/* 置顶栏：缓存时间 + 刷新 + 周几选择（桌面 chip 行 / 精简选天条）。 */}
      {result && (
        <div className="sticky top-0 z-30 border-y border-outline-variant/10 bg-surface-container-lowest px-4 pb-2 pt-1.5 md:px-6">
          <div className="mb-1.5 flex min-h-5 flex-wrap items-center justify-end gap-2">
            {error && (
              <span className="whitespace-nowrap font-label text-[10px] tracking-wider text-error">
                ⚠ {error}
              </span>
            )}
            <span className="whitespace-nowrap font-label text-[10px] tracking-wider text-on-surface-variant/50">
              {result.fromCache ? '缓存：' : '刚拉取：'}
              {formatRelTime(result.updatedAt)}
            </span>
            <button
              onClick={() => load(true)}
              disabled={refreshing}
              title="强制刷新（绕过 14 天缓存）"
              className="flex items-center gap-1 rounded border border-outline-variant/20 bg-surface-container-high px-2 py-0.5 font-label text-[10px] uppercase tracking-widest transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="refresh" size={12} className={refreshing ? 'animate-spin' : ''} />
              <span>{refreshing ? '更新中' : '刷新'}</span>
            </button>
          </div>
          {isCompact ? (
            <CompactDaySelector result={result} selected={selectedDay} onSelect={setSelectedDay} />
          ) : (
            <DayChipsBar result={result} />
          )}
        </div>
      )}

      {loading && !result && <LoadingState />}
      {error && !result && <ErrorState message={error} onRetry={() => load(true)} />}
      {result &&
        (isCompact ? (
          <CompactDayGrid result={result} day={selectedDay} />
        ) : (
          <CalendarGrid result={result} />
        ))}
    </div>
  )
}

// ── 桌面：周一-周日 chip 行（grid-cols-7，与卡片网格逐列对齐） ──────────────────
function DayChipsBar({ result }: { result: CalendarResult }): JSX.Element {
  const today = useMemo(todayBgmId, [])
  return (
    <div className="grid min-w-0 grid-cols-7 gap-3">
      {result.data.map((day) => {
        const active = day.id === today
        return (
          <div
            key={day.id}
            className={`flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5 ${
              active
                ? 'border-primary/30 bg-primary/12 text-primary'
                : 'border-outline-variant/15 bg-surface-container text-on-surface-variant/80'
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

// ── 精简：选天条（7 等宽单字按钮） ─────────────────────────────────────────────
function CompactDaySelector({
  result,
  selected,
  onSelect,
}: {
  result: CalendarResult
  selected: number
  onSelect: (id: number) => void
}): JSX.Element {
  return (
    <div className="flex gap-1.5">
      {result.data.map((day) => {
        const active = day.id === selected
        return (
          <button
            key={day.id}
            onClick={() => onSelect(day.id)}
            title={`${day.label} · ${day.items.length} 部`}
            className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md border py-1.5 transition-colors ${
              active
                ? 'border-primary/30 bg-primary/12 text-primary'
                : 'border-outline-variant/15 bg-surface-container text-on-surface-variant/70 hover:text-on-surface'
            }`}
          >
            <span className="font-headline text-sm font-black leading-none tracking-tight">
              {SHORT_DAY[day.id] ?? day.label}
            </span>
            <span className="font-label text-[9px] leading-none tabular-nums opacity-60">
              {day.items.length}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ── 精简 body：当天番剧多列网格（手机 2 / 大手机 3 / 平板 4） ───────────────────
function CompactDayGrid({ result, day }: { result: CalendarResult; day: number }): JSX.Element {
  const current = result.data.find((d) => d.id === day) ?? result.data[0]
  if (!current || current.items.length === 0) return <EmptyState label="这天没有番" />
  return (
    <div className="grid grid-cols-2 gap-3 px-4 py-3 sm:grid-cols-3 md:grid-cols-4 md:px-6">
      {current.items.map((item) => (
        <CalendarCard key={item.id} item={item} />
      ))}
    </div>
  )
}

// ── 桌面 body：7 列整周一览 ────────────────────────────────────────────────────
function CalendarGrid({ result }: { result: CalendarResult }): JSX.Element {
  if (result.data.every((d) => d.items.length === 0)) return <EmptyState label="本周没有数据" />
  return (
    <div className="grid grid-cols-7 gap-3 px-6 py-3">
      {result.data.map((day) => (
        <DayColumn key={day.id} day={day} />
      ))}
    </div>
  )
}

function DayColumn({ day }: { day: CalendarWeekday }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {day.items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-outline-variant/20 px-3 py-6 text-center font-label text-[10px] uppercase tracking-widest text-on-surface-variant/30">
          空
        </div>
      ) : (
        day.items.map((item) => <CalendarCard key={item.id} item={item} />)
      )}
    </div>
  )
}

// ── 海报卡 ─────────────────────────────────────────────────────────────────────
function CalendarCard({ item }: { item: CalendarItem }): JSX.Element {
  const displayTitle = item.name_cn || item.name
  const sub = item.name_cn && item.name && item.name !== item.name_cn ? item.name : ''

  return (
    <div className="group relative overflow-hidden rounded-lg border border-outline-variant/15 bg-surface-container transition-colors hover:border-primary/30">
      <div className="relative aspect-[3/4]">
        {item.cover ? (
          <img
            src={item.cover}
            alt={displayTitle}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface-container-high text-on-surface-variant/20">
            <Icon name="image" size={30} />
          </div>
        )}

        {/* Hover 遮罩 —— 追番 / 播放到对应里程碑再补，这里先放 BGM 查看。 */}
        <div className="absolute inset-0 flex flex-col justify-end gap-1.5 bg-gradient-to-t from-black/95 via-black/75 to-black/25 p-2 opacity-0 transition-opacity group-hover:opacity-100">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            title="在 Bangumi 查看"
            className="flex w-full items-center justify-center gap-1 rounded-md border border-white/20 bg-black/55 py-1.5 font-label text-[10px] uppercase tracking-widest text-white/90 backdrop-blur-sm transition-colors hover:bg-black/70"
          >
            <Icon name="open_in_new" size={12} />
            <span>BGM</span>
          </a>
        </div>
      </div>

      {/* 信息区固定高度，保证所有卡片等高（与 app 一致）。 */}
      <div className="flex flex-col gap-0.5 px-2 py-2">
        <h3
          className="line-clamp-2 h-[30px] text-xs font-bold leading-tight text-on-surface"
          title={displayTitle}
        >
          {displayTitle}
        </h3>
        <p
          className="line-clamp-1 h-[14px] text-[10px] leading-tight text-on-surface-variant/40"
          title={sub || undefined}
        >
          {sub || ' '}
        </p>
        <div className="flex h-[12px] items-center justify-between gap-1">
          <span className="font-label text-[9px] leading-none text-primary/70">
            {item.score > 0 ? `★ ${item.score.toFixed(1)}` : ''}
          </span>
          <span className="font-label text-[9px] leading-none tracking-wider text-on-surface-variant/40">
            {item.episodes > 0 ? `${item.episodes} eps` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── 状态 ───────────────────────────────────────────────────────────────────────
function LoadingState(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-32">
      <Spinner size={40} className="text-primary/60" />
      <p className="font-label text-xs uppercase tracking-widest text-on-surface-variant/40">
        Loading calendar...
      </p>
    </div>
  )
}

function EmptyState({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-32 text-on-surface-variant/30">
      <Icon name="event_busy" size={60} />
      <p className="font-label text-xs uppercase tracking-widest">{label}</p>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-32 text-on-surface-variant/60">
      <Icon name="error" size={48} className="text-error/70" />
      <p className="max-w-md text-center font-label text-sm">加载失败：{message}</p>
      <button
        onClick={onRetry}
        className="rounded-md border border-outline-variant/30 bg-surface-container-high px-4 py-1.5 font-label text-xs uppercase tracking-widest transition-colors hover:border-primary/30 hover:text-primary"
      >
        重试
      </button>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatRelTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
