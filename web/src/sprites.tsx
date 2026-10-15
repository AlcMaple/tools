import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// 立绘风格：新版 = 画稿（pop/*.webp 贴在纸上），旧版 = 全身站立的官方立绘 + 气泡。
// 页面只通过 useSpriteStyle() / spriteSrc() 取图，不各自判断素材路径。
export type SpriteStyle = 'new' | 'old'

const KEY = 'sprite-style'
const EVENT = 'sprite-style-change'

function read(): SpriteStyle {
  try {
    return window.localStorage.getItem(KEY) === 'old' ? 'old' : 'new'
  } catch {
    return 'new'
  }
}

export function setSpriteStyle(next: SpriteStyle): void {
  try {
    window.localStorage.setItem(KEY, next)
  } catch {
    // 存储不可用时本次会话内不记住。
  }
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function useSpriteStyle(): SpriteStyle {
  return useSyncExternalStore(subscribe, read, () => 'new')
}

// 两套素材的对照；旧版缺的位置（周历/追番页头）用整块全身立绘代替，所以不列在这里
const ART = {
  empty: { new: '/assets/pop/empty.webp', old: '/assets/sagiri-mascot.webp' },
} as const

export function spriteSrc(kind: keyof typeof ART, style: SpriteStyle): string {
  return ART[kind][style]
}

// 旧版：全身立绘 + 气泡。inline = 手机并排版（CSS 按宽度切换），box = 桌面驻场
export function LegacyRig({
  src,
  alt,
  text,
  variant,
}: {
  src: string
  alt: string
  text: ReactNode
  variant: 'inline' | 'box'
}): JSX.Element {
  const body = (
    <>
      <img className="rig" src={src} alt={alt} />
      <div className="bubble rig-bubble"><span>{text}</span></div>
    </>
  )
  return variant === 'inline' ? <div className="rig-inline mt16">{body}</div> : <div className="rig-box">{body}</div>
}

// ── 周历：可拖动的全身立绘（原样取自 9bed4ce 之前的 CalendarPage） ──
type CalendarLayout = 'horizontal' | 'vertical'
type Point = { x: number; y: number }

const SAGIRI_LINES: Record<CalendarLayout, readonly [string, string]> = {
  horizontal: [
    '右边的番剧还有好多呢…\n点那颗小箭头，就能一直看下去啦',
    '一周排片都在这页上，慢慢挑～',
  ],
  vertical: [
    '整周的番剧都铺在这一页了\n往下滑，慢慢挑吧～',
    '想看哪天，就滑到哪天～',
  ],
}
const SAGIRI_SWAP_MS = 4200
const RIG_POSITION_KEY = 'calendar-rig-position'
const DEFAULT_RIG_POSITION: Point = { x: 0, y: 0 }

function clampRigPosition(position: Point, bounds: { left: number; top: number; width: number; height: number }, size: { width: number; height: number }): Point {
  const edge = 8
  return {
    x: Math.max(bounds.left + edge, Math.min(bounds.left + Math.max(edge, bounds.width - size.width - edge), position.x)),
    y: Math.max(bounds.top + edge, Math.min(bounds.top + Math.max(edge, bounds.height - size.height - edge), position.y)),
  }
}

function readRigPosition(): (Point & { version?: number }) | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RIG_POSITION_KEY) || 'null') as (Point & { version?: number }) | null
    return parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y) ? parsed : null
  } catch {
    return null
  }
}

function useDraggableRig() {
  const anchorRef = useRef<HTMLDivElement>(null)
  const elementRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Point | null>(null)
  const [dragging, setDragging] = useState(false)
  const positionRef = useRef<Point | null>(null)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: Point } | null>(null)

  const constrain = (next: Point): Point => {
    const viewport = window.visualViewport
    return clampRigPosition(next, {
      left: viewport?.offsetLeft ?? 0,
      top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? document.documentElement.clientWidth,
      height: viewport?.height ?? window.innerHeight,
    }, elementRef.current?.getBoundingClientRect() ?? { width: 0, height: 0 })
  }
  const home = (): Point => {
    const anchor = anchorRef.current?.getBoundingClientRect()
    const width = elementRef.current?.getBoundingClientRect().width ?? 0
    return constrain({ x: (anchor?.right ?? window.innerWidth) - width, y: anchor?.top ?? 24 })
  }
  const update = (next: Point): void => {
    const value = constrain(next)
    positionRef.current = value
    setPosition(previous => previous?.x === value.x && previous.y === value.y ? previous : value)
  }
  const finish = (): void => {
    const pointerId = drag.current?.pointerId
    drag.current = null
    if (pointerId != null && elementRef.current?.hasPointerCapture(pointerId)) elementRef.current.releasePointerCapture(pointerId)
    setDragging(false)
  }

  useLayoutEffect(() => {
    const saved = readRigPosition()
    const initial = home()
    update(saved?.version === 2 ? saved : saved ? { x: initial.x + saved.x, y: initial.y + saved.y } : initial)
    const resize = (): void => {
      finish()
      if (positionRef.current) update(positionRef.current)
    }
    const observer = new ResizeObserver(resize)
    if (elementRef.current) observer.observe(elementRef.current)
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('scroll', resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('scroll', resize)
    }
  }, [])

  useEffect(() => {
    if (!position || dragging) return
    try {
      window.localStorage.setItem(RIG_POSITION_KEY, JSON.stringify({ ...position, version: 2 }))
    } catch {
      // 存储不可用时仍可拖动，只是不跨刷新保存。
    }
  }, [position, dragging])

  const reset = (): void => {
    finish()
    update(home())
  }
  return {
    anchorRef,
    elementRef,
    position: position ?? DEFAULT_RIG_POSITION,
    ready: position !== null,
    dragging,
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0 || drag.current || !positionRef.current) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin: positionRef.current }
      setDragging(true)
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>): void => {
      const d = drag.current
      if (!d || d.pointerId !== e.pointerId) return
      e.preventDefault()
      update({ x: d.origin.x + e.clientX - d.startX, y: d.origin.y + e.clientY - d.startY })
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>): void => {
      if (drag.current?.pointerId === e.pointerId) finish()
    },
    onLostPointerCapture: finish,
    onDoubleClick: reset,
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape' || e.key === 'Home') {
        e.preventDefault()
        reset()
      }
    },
  }
}

function DesktopCalendarRig({ children }: { children: ReactNode }): JSX.Element {
  const rig = useDraggableRig()
  return (
    <>
      <div ref={rig.anchorRef} className="calendar-rig-layer" />
      {createPortal(<div className="calendar-rig-overlay">
        <div
          ref={rig.elementRef}
          className={`calendar-rig${rig.dragging ? ' dragging' : ''}`}
          style={{ transform: `translate3d(${rig.position.x}px, ${rig.position.y}px, 0)`, visibility: rig.ready ? undefined : 'hidden' }}
          role="img"
          aria-label="和泉纱雾驻场贴纸，可按住拖动；双击或按 Home 归位"
          tabIndex={0}
          title="按住拖动纱雾和气泡；双击归位"
          onPointerDown={rig.onPointerDown}
          onPointerMove={rig.onPointerMove}
          onPointerUp={rig.onPointerUp}
          onPointerCancel={rig.onPointerUp}
          onLostPointerCapture={rig.onLostPointerCapture}
          onDoubleClick={rig.onDoubleClick}
          onKeyDown={rig.onKeyDown}
        >
          {children}
        </div>
      </div>, document.getElementById('root') ?? document.body)}
    </>
  )
}

export function LegacyCalendarRig({ layout, wide }: { layout: CalendarLayout; wide: boolean }): JSX.Element {
  const [line, setLine] = useState<'a' | 'b'>('a')
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = window.setInterval(() => setLine((p) => (p === 'a' ? 'b' : 'a')), SAGIRI_SWAP_MS)
    return () => window.clearInterval(t)
  }, [])
  useEffect(() => setLine('a'), [layout])
  const lines = SAGIRI_LINES[layout]
  const content = (
    <>
      <img className="rig" src="/assets/sagiri-full.webp" alt="和泉纱雾 · 官方立绘（全身）" draggable={false} />
      <div className="bubble rig-bubble">
        <span className={`sagiri-line${line === 'a' ? ' show' : ''}`}>{lines[0]}</span>
        <span className={`sagiri-line${line === 'b' ? ' show' : ''}`}>{lines[1]}</span>
      </div>
    </>
  )
  return wide ? <DesktopCalendarRig>{content}</DesktopCalendarRig> : (
    <div className="calendar-rig calendar-rig-inline" role="img" aria-label="和泉纱雾驻场贴纸">{content}</div>
  )
}
