import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarItem, CalendarResult, CalendarWeekday } from './api'
import { coverUrl, fetchCalendar, putTrack, deleteTrack } from './api'
import { useAuth } from './auth'
import { cacheGet, cacheSet } from './dataCache'
import { loadTracks, runTracksMutation } from './tracksSync'
import { Ic, Spinner } from './SketchIcon'
import { toast } from './Toast'
import { useIsWide } from './useMediaQuery'

// 皮肤 = 原型稿 index.html（番剧周历）：横向海报胶片 + 可拖动立绘驻场，另有纵向布局。
// 横向布局保留日期章选天（窄屏）和每周一行胶片（宽屏）；纵向布局一次展开七天。
// 数据流与旧版一致：
// 14 天缓存窗口 + 刷新绕过缓存；追番角标常驻（不依赖 hover），乐观更新后由 tracksSync 校正。

// 周历数据信 14 天的缓存窗口——跟桌面端、跟服务端自己的 14 天缓存一致。BGM 是外部接口，
// 缓存没过期就没必要发请求（唯一主动绕过缓存的入口是「刷新」按钮）。
const CALENDAR_CACHE_KEY = 'calendar'
const CALENDAR_TTL = 14 * 24 * 60 * 60_000

// 纱雾驻场气泡的两句台词：一句引导向右（因为看不到右边还有内容正是这页的痛点），
// 一句是原来的「一周的排片都在这页上」。每隔几秒换一句；减少动态效果时固定第一句。
const SAGIRI_A = '右边的番剧还有好多呢…\n点那颗小箭头，就能一直看下去啦'
const SAGIRI_B = '一周的排片都在这页上，慢慢挑吧～'
const SAGIRI_SWAP_MS = 4200

type CalendarLayout = 'horizontal' | 'vertical'
type Point = { x: number; y: number }

const CALENDAR_LAYOUT_KEY = 'calendar-layout'
const CALENDAR_RIG_POSITION_KEY = 'calendar-rig-position'
const DEFAULT_RIG_POSITION: Point = { x: 0, y: 0 }

function clampRigPosition(position: Point): Point {
  if (typeof window === 'undefined') return position
  // 手机端立绘是内联贴纸，限制横向偏移避免整张贴纸被拖出屏幕；宽屏则给卡片留出较大的挪动范围。
  const compact = window.innerWidth <= 960
  const maxTravel = compact ? 16 : Math.max(180, Math.round(window.innerWidth * 0.32))
  const maxY = compact ? 220 : Math.max(260, Math.round(window.innerHeight * 0.55))

  // stage 右缘通常离视口还有一段 padding；用未变换前的 offsetLeft 算出屏幕边界，
  // 防止用户把贴纸拖到视口外后制造整页横向滚动。DOM 尚未挂载时退回 maxTravel。
  let minX = -maxTravel
  let maxX = maxTravel
  const stage = document.querySelector<HTMLElement>('.calendar-stage')
  const rig = document.querySelector<HTMLElement>('.calendar-rig')
  if (stage && rig) {
    const stageRect = stage.getBoundingClientRect()
    const baseLeft = stageRect.left + rig.offsetLeft
    const width = rig.offsetWidth
    const edge = compact ? 16 : 32
    minX = Math.max(minX, edge - baseLeft)
    maxX = Math.min(maxX, window.innerWidth - edge - (baseLeft + width))
  }
  return {
    x: Math.max(minX, Math.min(maxX, position.x)),
    y: Math.max(-maxY, Math.min(maxY, position.y)),
  }
}

function readCalendarLayout(): CalendarLayout {
  if (typeof window === 'undefined') return 'horizontal'
  try {
    const value = window.localStorage.getItem(CALENDAR_LAYOUT_KEY)
    return value === 'vertical' ? 'vertical' : 'horizontal'
  } catch {
    return 'horizontal'
  }
}

function readRigPosition(): Point {
  if (typeof window === 'undefined') return DEFAULT_RIG_POSITION
  try {
    const raw = window.localStorage.getItem(CALENDAR_RIG_POSITION_KEY)
    if (!raw) return DEFAULT_RIG_POSITION
    const parsed = JSON.parse(raw) as Partial<Point>
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return DEFAULT_RIG_POSITION
    return { x: Math.round(parsed.x as number), y: Math.round(parsed.y as number) }
  } catch {
    return DEFAULT_RIG_POSITION
  }
}

// 立绘和气泡是同一个可拖动的贴纸：指针按下后由 wrapper 捕获，避免拖到气泡外就断开。
// 坐标写进 localStorage，刷新后仍保留用户摆好的位置；Escape 或双击可快速归位。
function useDraggableRig(): {
  position: Point
  dragging: boolean
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
  onDoubleClick: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
} {
  const [position, setPosition] = useState<Point>(readRigPosition)
  const [dragging, setDragging] = useState(false)
  const positionRef = useRef(position)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: Point } | null>(null)

  useEffect(() => {
    positionRef.current = position
    try {
      window.localStorage.setItem(CALENDAR_RIG_POSITION_KEY, JSON.stringify(position))
    } catch {
      // 私密浏览或存储空间不足时，位置仍保留在本次页面生命周期里。
    }
  }, [position])

  useEffect(() => {
    const onResize = (): void => setPosition((previous) => clampRigPosition(previous))
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: positionRef.current,
    }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    e.preventDefault()
    setPosition(clampRigPosition({
      x: d.origin.x + e.clientX - d.startX,
      y: d.origin.y + e.clientY - d.startY,
    }))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    drag.current = null
    setDragging(false)
  }

  const reset = (): void => {
    drag.current = null
    setPosition(DEFAULT_RIG_POSITION)
    setDragging(false)
  }

  return {
    position,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick: reset,
    onKeyDown: (e) => {
      if (e.key === 'Escape' || e.key === 'Home') {
        e.preventDefault()
        reset()
      }
    },
  }
}

function todayBgmId(): number {
  const d = new Date().getDay() // 0=周日..6=周六
  return d === 0 ? 7 : d
}

// 本周（含今天的自然周）周一到周日的月/日 —— 日期章上的手写数字。
function weekDates(): Record<number, { m: number; d: number }> {
  const now = new Date()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  const out: Record<number, { m: number; d: number }> = {}
  for (let i = 1; i <= 7; i++) {
    const dt = new Date(monday)
    dt.setDate(monday.getDate() + (i - 1))
    out[i] = { m: dt.getMonth() + 1, d: dt.getDate() }
  }
  return out
}

// Windows 上原生 overflow-x 容器左键拖拽不滚动（会变成文本/元素选区），右键拖拽又因为
// scroll-snap 冲过头 —— 这里用 pointer 事件接管左键拖拽，直接改 scrollLeft，两侧都跟手，
// 松手后按最近几帧的速度做惯性滑行（配合 CSS 关掉 scroll-snap），才是触控板/触屏那种
// "跟手 + 滑一段再停" 的手感，而不是原来那种松手就一整张地对齐跳过去。
// 卡片标题（.poster-title）要能正常拖蓝选字，所以按下时若落在它上面就整个放弃接管，
// 交还给浏览器原生的文字选区。
const NO_DRAG_SELECTOR = '.poster-title'
const FRICTION = 0.95
const MIN_VELOCITY = 0.05

function useDragScroll<T extends HTMLElement>(ref: React.RefObject<T>): {
  onPointerDown: (e: React.PointerEvent<T>) => void
  onPointerMove: (e: React.PointerEvent<T>) => void
  onPointerUp: (e: React.PointerEvent<T>) => void
  onClickCapture: (e: React.MouseEvent<T>) => void
} {
  const drag = useRef<{
    startX: number
    startScroll: number
    moved: boolean
    lastX: number
    lastT: number
    velocity: number
  } | null>(null)
  const suppressClick = useRef(false)
  const momentumFrame = useRef<number | null>(null)

  const stopMomentum = (): void => {
    if (momentumFrame.current !== null) {
      cancelAnimationFrame(momentumFrame.current)
      momentumFrame.current = null
    }
  }

  const runMomentum = (velocity: number): void => {
    const el = ref.current
    if (!el) return
    let v = velocity
    const step = (): void => {
      if (!el || Math.abs(v) < MIN_VELOCITY) {
        momentumFrame.current = null
        return
      }
      el.scrollLeft -= v * 16
      v *= FRICTION
      momentumFrame.current = requestAnimationFrame(step)
    }
    momentumFrame.current = requestAnimationFrame(step)
  }

  const onPointerDown = (e: React.PointerEvent<T>): void => {
    if (e.button !== 0 || !ref.current) return
    if ((e.target as HTMLElement).closest?.(NO_DRAG_SELECTOR)) return
    stopMomentum()
    const now = performance.now()
    drag.current = {
      startX: e.clientX,
      startScroll: ref.current.scrollLeft,
      moved: false,
      lastX: e.clientX,
      lastT: now,
      velocity: 0,
    }
  }

  const onPointerMove = (e: React.PointerEvent<T>): void => {
    const d = drag.current
    const el = ref.current
    if (!d || !el) return
    const dx = e.clientX - d.startX
    if (!d.moved && Math.abs(dx) < 4) return
    if (!d.moved) {
      d.moved = true
      el.setPointerCapture(e.pointerId)
    }
    e.preventDefault()
    el.scrollLeft = d.startScroll - dx

    const now = performance.now()
    const dt = now - d.lastT
    if (dt > 0) {
      // 瞬时速度，指数平滑一下避免抖动被最后一帧的噪声带偏
      const instant = (e.clientX - d.lastX) / dt
      d.velocity = d.velocity * 0.7 + instant * 0.3
    }
    d.lastX = e.clientX
    d.lastT = now
  }

  const onPointerUp = (e: React.PointerEvent<T>): void => {
    const d = drag.current
    if (d?.moved) {
      suppressClick.current = true
      if (ref.current?.hasPointerCapture(e.pointerId)) {
        ref.current.releasePointerCapture(e.pointerId)
      }
      if (Math.abs(d.velocity) > MIN_VELOCITY) runMomentum(d.velocity)
    }
    drag.current = null
  }

  // 拖拽结束时松手落在按钮（日期章）上会顺带触发一次 click —— 拖过了就吞掉这次点击。
  const onClickCapture = (e: React.MouseEvent<T>): void => {
    if (suppressClick.current) {
      suppressClick.current = false
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return { onPointerDown, onPointerMove, onPointerUp, onClickCapture }
}

// 胶片翻页器的滚动状态：能否往左 / 往右翻、右边还有几部没露出。
// 只在内容溢出（scrollWidth > clientWidth）时才算「还有」，否则两侧箭头都隐藏。
// 翻页按「一屏宽度」推进，一次一屏，跟拖拽后停在整张卡的既定手感不冲突。
// 到边后就收起对应按钮，省得出现一个点了没反应的箭头。
function useFilmPager(el: React.RefObject<HTMLDivElement>, itemCount: number): {
  canPrev: boolean
  canNext: boolean
  remainingNext: number
  goPrev: () => void
  goNext: () => void
} {
  const [canPrev, setCanPrev] = useState(false)
  const [canNext, setCanNext] = useState(false)
  const [remainingNext, setRemainingNext] = useState(0)

  const update = (): void => {
    const c = el.current
    if (!c) return
    const max = c.scrollWidth - c.clientWidth
    setCanPrev(c.scrollLeft > 4)
    setCanNext(c.scrollLeft < max - 4)
    // 数一下还有几张卡片完全露不出来：取 .poster 子元素，右缘超出可视右缘的都算「还在外面」。
    const cards = Array.from(c.querySelectorAll<HTMLElement>('.poster'))
    const right = c.scrollLeft + c.clientWidth
    let outside = 0
    for (const card of cards) {
      if (card.offsetLeft + card.offsetWidth > right + 4) outside++
    }
    setRemainingNext(outside)
  }

  useEffect(() => {
    const c = el.current
    if (!c) return
    update()
    c.addEventListener('scroll', update, { passive: true })
    // 刷新后 itemCount 会让 effect 重跑；断点切换改 --film-cols 时则由观察器校准宽度。
    const ro = new ResizeObserver(() => update())
    ro.observe(c)
    return () => {
      c.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [el, itemCount])

  const go = (dir: 1 | -1): void => {
    const c = el.current
    if (!c) return
    const max = Math.max(c.scrollWidth - c.clientWidth, 0)
    const target =
      dir === 1
        ? c.scrollLeft >= max - 4
          ? max
          : c.scrollLeft + c.clientWidth
        : c.scrollLeft <= 4
          ? 0
          : c.scrollLeft - c.clientWidth
    c.scrollTo({ left: target, behavior: 'smooth' })
  }

  return { canPrev, canNext, remainingNext, goPrev: () => go(-1), goNext: () => go(1) }
}

export function CalendarPage(): JSX.Element {
  const [result, setResult] = useState<CalendarResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tracksError, setTracksError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedDay, setSelectedDay] = useState(todayBgmId)
  const { user } = useAuth()
  // 已追的 bgmId —— 用来给海报画「已收藏」描边 / 切圆章按钮图标。未登录就是空集（按钮不显示）。
  const [tracked, setTracked] = useState<Set<number>>(new Set())
  // 纱雾驻场气泡两句话轮换：一会儿引导向右（这页的痛点），一会儿回到「慢慢挑」的闲适。
  const [sagiriLine, setSagiriLine] = useState<'a' | 'b'>('a')
  useEffect(() => {
    // 系统要求减少动态效果时，保留最关键的右翻提示，不再轮换台词。
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = window.setInterval(() => setSagiriLine((p) => (p === 'a' ? 'b' : 'a')), SAGIRI_SWAP_MS)
    return () => window.clearInterval(t)
  }, [])
  const dates = useMemo(weekDates, [])
  const todayId = useMemo(todayBgmId, [])
  // 默认保留截图里的横向布局；「纵向」是同一份数据的第二种浏览方式，选择会记住。
  const [layoutMode, setLayoutMode] = useState<CalendarLayout>(readCalendarLayout)
  const wide = useIsWide()
  const rig = useDraggableRig()

  useEffect(() => {
    try {
      window.localStorage.setItem(CALENDAR_LAYOUT_KEY, layoutMode)
    } catch {
      // 存储不可用时不影响本次切换。
    }
  }, [layoutMode])

  // 复用 TracksPage 同一套「秒开缓存 + 后台校验」逻辑（tracksSync.ts）——两页共享
  // 同一份 tracks:<username> 缓存，谁先加载过谁就替对方省一次请求。
  useEffect(() => {
    if (!user) {
      setTracked(new Set())
      setTracksError(null)
      return
    }
    return loadTracks(
      user.username,
      (ts) => setTracked(new Set(ts.map((t) => t.bgmId))),
      setTracksError,
    )
  }, [user])

  // 先改本地再发请求 —— 点了要立刻有反馈。单条响应不直接落页面；最后一个并行写结束后
  // tracksSync 会拉权威全量列表，成功和失败都据此校正角标。
  const toggleTrack = (item: CalendarItem, weekday: number): void => {
    if (!user) return
    setError(null)
    const on = tracked.has(item.id)
    const title = item.name_cn || item.name
    setTracked((prev) => {
      const next = new Set(prev)
      on ? next.delete(item.id) : next.add(item.id)
      return next
    })
    toast(on ? '已取消追番' : `已把『${title}』加入追番`)
    void runTracksMutation(user.username, async () => {
      if (on) {
        await deleteTrack(item.id)
      } else {
        await putTrack(item.id, {
          status: 'watching',
          title: item.name,
          titleCn: item.name_cn,
          cover: item.cover,
          airWeekday: weekday,
          score: item.score,
        })
      }
    }).catch((e: Error) => setError(e.message))
  }

  const load = (force = false): void => {
    if (force) setRefreshing(true)
    else if (!result) setLoading(true)
    setError(null)
    fetchCalendar(force)
      .then((r) => {
        setResult(r)
        cacheSet(CALENDAR_CACHE_KEY, r)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }

  useEffect(() => {
    const cached = cacheGet<CalendarResult>(CALENDAR_CACHE_KEY, CALENDAR_TTL)
    if (cached) {
      setResult(cached)
      setLoading(false)
      return
    }
    load()
  }, [])

  const selected = result?.data.find((d) => d.id === selectedDay)
  const range = result
    ? `${dates[1].m}/${dates[1].d} – ${dates[7].m}/${dates[7].d}`
    : ''

  const renderDaySection = (day: CalendarWeekday, vertical = false): JSX.Element => (
    <section key={day.id} id={`day-sec-${day.id}`} className="day-sec">
      <DayHead day={day} date={dates[day.id]} today={day.id === todayId} />
      <FilmRow label={`${day.label}在播番剧`} itemCount={day.items.length} vertical={vertical}>
        <DayFilm
          day={day}
          canTrack={!!user}
          tracked={tracked}
          onToggle={toggleTrack}
        />
      </FilmRow>
    </section>
  )

  return (
    <>
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 className="title-sketch" style={{ fontSize: 34 }}>
            番剧周历
          </h1>
          <p className="muted small mt8">
            {range && (
              <>
                本季 · {range} · {layoutMode === 'vertical' ? '查看整周排片' : '按日期浏览'}
              </>
            )}
            {result && (
              <>
                {' '}
                <span className="faint">
                  （{result.fromCache ? '缓存' : '刚拉取'}：{formatRelTime(result.updatedAt)}）
                </span>
              </>
            )}
          </p>
        </div>
        <div className="row calendar-actions">
          <div className="seg calendar-layout-toggle" role="group" aria-label="浏览方式">
            <button
              type="button"
              className={layoutMode === 'horizontal' ? 'on' : ''}
              aria-pressed={layoutMode === 'horizontal'}
              onClick={() => setLayoutMode('horizontal')}
            >
              横向
            </button>
            <button
              type="button"
              className={layoutMode === 'vertical' ? 'on' : ''}
              aria-pressed={layoutMode === 'vertical'}
              onClick={() => setLayoutMode('vertical')}
            >
              纵向
            </button>
          </div>
          <button
            className="icon-btn"
            onClick={() => load(true)}
            disabled={refreshing}
            title="刷新周历（绕过缓存）"
            aria-label="刷新周历"
          >
            <Ic name="refresh" cls={refreshing ? 'ic animate-spin' : 'ic'} />
          </button>
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => {
              if (layoutMode === 'vertical' || wide) {
                document.getElementById(`day-sec-${todayId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              } else {
                setSelectedDay(todayId)
              }
              toast('已回到今天')
            }}
          >
            <Ic name="calendar" cls="ic ic-sm" />
            回到今天
          </button>
        </div>
      </div>

      {(error || tracksError) && (
        <p className="form-note err mt8" aria-live="polite">
          ⚠ {error ?? tracksError}
        </p>
      )}

      <div className={`calendar-stage mt16 layout-${layoutMode}`}>
        <div className="calendar-rig-layer">
          <div
            className={`calendar-rig${rig.dragging ? ' dragging' : ''}`}
            style={{ transform: `translate3d(${rig.position.x}px, ${rig.position.y}px, 0)` }}
            role="img"
            aria-label="和泉纱雾驻场贴纸，可按住拖动；双击或按 Home 归位"
            tabIndex={0}
            title="按住拖动纱雾和气泡；双击归位"
            onPointerDown={rig.onPointerDown}
            onPointerMove={rig.onPointerMove}
            onPointerUp={rig.onPointerUp}
            onPointerCancel={rig.onPointerUp}
            onDoubleClick={rig.onDoubleClick}
            onKeyDown={rig.onKeyDown}
          >
            <img className="rig" src="/assets/sagiri-full.webp" alt="和泉纱雾 · 官方立绘（全身）" draggable={false} />
            <div className="bubble rig-bubble">
              <span className={`sagiri-line${sagiriLine === 'a' ? ' show' : ''}`}>
                {SAGIRI_A}
              </span>
              <span className={`sagiri-line${sagiriLine === 'b' ? ' show' : ''}`}>
                {SAGIRI_B}
              </span>
              <small className="rig-drag-hint">按住我和气泡拖一拖，想放哪儿都行～</small>
            </div>
            <span className="kira" style={{ bottom: 78, right: -10, transform: 'rotate(6deg)' }}>
              サラサラ
            </span>
          </div>
        </div>

        <div className="calendar-content">
          {layoutMode === 'vertical' ? (
            <div className="calendar-vertical-view">
              {result?.data.map((day) => renderDaySection(day, true))}
            </div>
          ) : wide ? (
            // 宽屏横向布局：每个星期独占一行，卡片可继续向右拖动，不让立绘把内容截断。
            result?.data.map((day) => renderDaySection(day))
          ) : (
            <>
              <DateStrip>
                {result?.data.map((day) => (
                  <button
                    key={day.id}
                    type="button"
                    className={`dstamp${day.id === selectedDay ? ' on' : ''}${day.id === todayId ? ' today' : ''}`}
                    onClick={() => setSelectedDay(day.id)}
                    title={`${day.label} · ${day.items.length} 部`}
                  >
                    <span className="dw">{day.label}</span>
                    <span className="dnum">{dates[day.id]?.d ?? ''}</span>
                    <span className="dc">{day.items.length} 部</span>
                    {day.id === todayId && (
                      <svg className="clip-today" aria-hidden="true">
                        <use href="#i-clip" />
                      </svg>
                    )}
                  </button>
                ))}
              </DateStrip>

              {selected && renderDaySection(selected)}
            </>
          )}
        </div>
      </div>

      {loading && !result && (
        <div className="page-state">
          <Spinner size={36} />
          <p className="faint small">正在翻开这周的画稿…</p>
        </div>
      )}
      {error && !result && (
        <div className="page-state">
          <Ic name="alert" cls="ic" />
          <p className="small">周历加载失败：{error}</p>
          <button className="btn btn-sm" type="button" onClick={() => load(true)}>
            重试
          </button>
        </div>
      )}
    </>
  )
}

const ArrowIcon = ({ dir }: { dir: 'prev' | 'next' }): JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={dir === 'prev' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
  </svg>
)

function FilmRow({
  label,
  itemCount,
  vertical = false,
  children,
}: {
  label: string
  itemCount: number
  vertical?: boolean
  children: React.ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useDragScroll(ref)
  const pager = useFilmPager(ref, itemCount)

  // 拖动默认走 pointer 手势；箭头按钮是独立按钮，不冲突。
  const countLabel = pager.canNext
    ? `右边还有 ${pager.remainingNext} 部，点箭头继续看～`
    : '翻到最右边啦，往左看看吧～'

  return (
    <div className={`film-wrap${vertical ? ' vertical' : ''}`}>
      <span className="film-count" hidden={!pager.canNext && !pager.canPrev} aria-hidden="true">
        {countLabel}
      </span>
      <button
        type="button"
        className="film-nav prev"
        onClick={pager.goPrev}
        aria-label="上一屏番剧"
        hidden={!pager.canPrev}
      >
        <span className="nav-tape" />
        <ArrowIcon dir="prev" />
      </button>
      <div
        className={`film${vertical ? ' is-vertical' : ''}`}
        aria-label={label}
        ref={ref}
        onPointerDown={vertical ? undefined : drag.onPointerDown}
        onPointerMove={vertical ? undefined : drag.onPointerMove}
        onPointerUp={vertical ? undefined : drag.onPointerUp}
        onPointerCancel={vertical ? undefined : drag.onPointerUp}
        onClickCapture={vertical ? undefined : drag.onClickCapture}
      >
        {children}
      </div>
      <button
        type="button"
        className="film-nav next"
        onClick={pager.goNext}
        aria-label="下一屏番剧"
        hidden={!pager.canNext}
      >
        <span className="nav-tape" />
        <ArrowIcon dir="next" />
      </button>
    </div>
  )
}

function DateStrip({ children }: { children: React.ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useDragScroll(ref)
  return (
    <div
      className="date-strip"
      role="tablist"
      aria-label="选择日期"
      ref={ref}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerUp}
      onClickCapture={drag.onClickCapture}
    >
      {children}
    </div>
  )
}

// ── 日节头（缎带 + 日期 + 部数），整周纵览与手机选天共用 ────────────────────────
function DayHead({ day, date, today }: { day: { id: number; label: string; items: CalendarItem[] }; date: { m: number; d: number }; today: boolean }): JSX.Element {
  return (
    <div className="day-head">
      <span className={`ribbon${today ? ' sakura' : ''}`}>
        {today ? (
          <>
            <Ic name="star" cls="ic ic-sm" />
            今天
          </>
        ) : (
          day.label
        )}
      </span>
      <span className="font-hand muted">
        {date.m}/{date.d} · {day.items.length} 部在播
      </span>
      <hr className="hr-dash" />
      <span className="sparkle">✦</span>
    </div>
  )
}

function DayFilm({
  day,
  canTrack,
  tracked,
  onToggle,
}: {
  day: { id: number; items: CalendarItem[] }
  canTrack: boolean
  tracked: Set<number>
  onToggle: (item: CalendarItem, weekday: number) => void
}): JSX.Element {
  if (day.items.length === 0) {
    return <div className="film-empty faint">这一天没有排片</div>
  }
  return (
    <>
      {day.items.map((item) => (
        <Poster
          key={item.id}
          item={item}
          weekday={day.id}
          canTrack={canTrack}
          tracked={tracked.has(item.id)}
          onToggle={onToggle}
        />
      ))}
    </>
  )
}

// ── 拍立得海报卡（追番圆章常驻，无 hover 依赖） ──────────────────────────────────
function Poster({
  item,
  weekday,
  canTrack,
  tracked,
  onToggle,
}: {
  item: CalendarItem
  weekday: number
  canTrack: boolean
  tracked: boolean
  onToggle: (item: CalendarItem, weekday: number) => void
}): JSX.Element {
  const displayTitle = item.name_cn || item.name
  const on = tracked

  return (
    <article className={`poster${on ? ' tracked' : ''}`}>
      <div className="cover">
        {item.cover ? (
          <img
            className="cover-img"
            src={coverUrl(item.cover)}
            alt={`${displayTitle} 封面`}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : (
          <div className="cover-ph">☆</div>
        )}
        {canTrack && (
          <button
            type="button"
            className={`track-btn${on ? ' on' : ''}`}
            onClick={() => onToggle(item, weekday)}
            aria-label={on ? '取消追番' : '追番'}
            title={on ? '取消追番' : '加入我的追番'}
          >
            <Ic name={on ? 'check' : 'plus'} cls="ic" />
          </button>
        )}
      </div>
      <div className="poster-title" title={displayTitle}>
        {displayTitle}
      </div>
      <div className="poster-ep">{item.episodes > 0 ? `全 ${item.episodes} 集` : '连载中'}</div>
    </article>
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
