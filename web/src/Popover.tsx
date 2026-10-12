// 全站统一的浮层：下拉、多选过滤、更多操作菜单都走这里。
// 浮层挂到 body 并用 fixed 定位 —— 弹窗、折叠卡片、滚动列表这类带 overflow 的容器会把留在原处的
// 浮层裁掉（已踩：设置页密保下拉、重置密码弹窗的密保下拉）。下方放不下且上方更宽裕就向上翻；
// 点外面 / ESC 关闭；滚动、缩放时跟着触发器走。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function Popover({
  anchor,
  open,
  onClose,
  matchWidth = false,
  align = 'start',
  maxHeight = 240,
  className,
  role,
  children,
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  /** 宽度与触发器一致（下拉）；否则由内容 / CSS 的 min-width 决定（菜单）。 */
  matchWidth?: boolean
  /** 与触发器左缘还是右缘对齐。 */
  align?: 'start' | 'end'
  maxHeight?: number
  className?: string
  role?: string
  children: React.ReactNode
}): JSX.Element | null {
  const [pos, setPos] = useState<React.CSSProperties | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  const place = (): void => {
    const r = anchor.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    const up = below < Math.min(maxHeight, 220) && above > below
    setPos({
      position: 'fixed',
      zIndex: 400,
      maxHeight: Math.min(maxHeight, Math.max(120, up ? above : below)),
      top: up ? 'auto' : r.bottom + 6,
      bottom: up ? window.innerHeight - r.top + 6 : 'auto',
      left: align === 'start' ? r.left : 'auto',
      right: align === 'end' ? window.innerWidth - r.right : 'auto',
      width: matchWidth ? r.width : undefined,
    })
  }

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // mousedown 而非 click：勾选会重建列表，click 冒泡上来时 e.target 可能已不在 DOM 上，会被误判成点了外面。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!anchor.current?.contains(t) && !panel.current?.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open || !pos) return null
  return createPortal(
    <div ref={panel} className={`pop-float ${className ?? ''}`} style={pos} role={role}>
      {children}
    </div>,
    document.body,
  )
}
