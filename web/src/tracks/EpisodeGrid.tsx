import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import { specialAt, type EpisodeDetail, type EpisodeDetails, type EpisodeLayout } from '../../shared/episode-layout'

type Preview = { position: number; anchor: HTMLButtonElement }

function EpisodeTip({ id, preview, label, detail, fallback, status, note, onEnter, onLeave }: {
  id: string; preview: Preview; label: string; detail?: EpisodeDetail; fallback?: string; status?: string; note?: string
  onEnter: () => void; onLeave: () => void
}): JSX.Element {
  const tip = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; nub: number; above: boolean }>()
  useLayoutEffect(() => {
    const place = (): void => {
      if (!tip.current) return
      const b = preview.anchor.getBoundingClientRect(), box = tip.current.getBoundingClientRect()
      const cx = (b.left + b.right) / 2
      const dlg = preview.anchor.closest('.dlg')?.getBoundingClientRect()
      const inside = dlg && dlg.width >= box.width + 16
      const left = Math.max(inside ? dlg.left + 8 : 8, Math.min(cx - 15, (inside ? dlg.right : document.documentElement.clientWidth) - box.width - 8))
      const above = b.bottom + box.height + 8 > window.innerHeight && b.top > window.innerHeight - b.bottom
      const top = Math.max(6, Math.min(above ? b.top - box.height - 6 : b.bottom + 6, window.innerHeight - box.height - 6))
      setPos({ left, top, above, nub: Math.max(9, Math.min(box.width - 9, cx - left)) })
    }
    place()
    const dialog = preview.anchor.closest('.dlg')
    dialog?.addEventListener('animationend', place)
    return () => dialog?.removeEventListener('animationend', place)
  }, [preview, detail, status, note, fallback, label])
  const name = detail?.name || fallback || detail?.nameCn
  const zh = detail?.nameCn && detail.nameCn !== name ? detail.nameCn : ''
  const airdate = detail?.airdate && detail.airdate !== '0000-00-00' ? detail.airdate : ''
  const duration = detail?.duration.replace(/^00:(\d\d:\d\d)$/, '$1')
  return createPortal(
    <div ref={tip} className="ge-tip" id={id} role="tooltip" data-above={pos?.above}
      style={{ left: pos?.left, top: pos?.top, visibility: pos ? undefined : 'hidden', '--tip-x': `${pos?.nub ?? 15}px` } as CSSProperties}
      onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <div className="ge-tip-head"><b>{label}</b>{name && <span>{name}</span>}</div>
      {(zh || airdate || duration) && <dl>
        {zh && <><dt>中文标题</dt><dd>{zh}</dd></>}
        {airdate && <><dt>首播</dt><dd>{airdate}</dd></>}
        {duration && <><dt>时长</dt><dd>{duration}</dd></>}
      </dl>}
      {(status || (!name && !airdate && !duration)) && <p>{status || '暂无章节资料'}</p>}
      {note && <p className="ge-tip-note"><b>我的备注</b>{note}</p>}
    </div>, preview.anchor.closest('.dlg-backdrop') ?? document.body)
}

export function EpisodeGrid({ count, layout, details, status, marked, notes, onToggle, dismissTip }: {
  count: number; layout?: EpisodeLayout; details?: EpisodeDetails; status?: string
  marked: ReadonlySet<number>; notes: Record<number, string>; onToggle: (position: number) => void
  dismissTip: MutableRefObject<(() => void) | null>
}): JSX.Element {
  const [preview, setPreview] = useState<Preview | null>(null)
  const hideTimer = useRef(0), holdTimer = useRef(0)
  const held = useRef<HTMLButtonElement | null>(null)
  const mouse = useRef({ x: -1, y: -1 }), dismissedAt = useRef<{ x: number; y: number } | null>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const tipId = useId()
  const cancelHide = (): void => window.clearTimeout(hideTimer.current)
  const leave = (): void => {
    cancelHide()
    hideTimer.current = window.setTimeout(() => setPreview(null), 110)
  }
  const show = (position: number, anchor: HTMLButtonElement): void => {
    cancelHide()
    setPreview({ position, anchor })
  }
  const endHold = (): void => { window.clearTimeout(holdTimer.current); touch.current = null }
  const mouseOver = (n: number, anchor: HTMLButtonElement, x: number, y: number): void => {
    mouse.current = { x, y }
    // 浮层消失后鼠标下方的按钮会收到一次合成 enter，不要在原位置重新弹开
    if (dismissedAt.current?.x === x && dismissedAt.current.y === y) return
    dismissedAt.current = null
    cancelHide()
    if (preview?.position !== n) show(n, anchor)
  }
  useEffect(() => () => { window.clearTimeout(hideTimer.current); window.clearTimeout(holdTimer.current) }, [])
  useLayoutEffect(() => {
    if (!preview) return
    const close = (): void => setPreview(null)
    dismissTip.current = () => { dismissedAt.current = mouse.current; close() }
    const remember = (e: PointerEvent): void => { if (e.pointerType === 'mouse') mouse.current = { x: e.clientX, y: e.clientY } }
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || (!preview.anchor.contains(e.target) && !e.target.closest('.ge-tip'))) close()
    }
    window.addEventListener('pointermove', remember, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      dismissTip.current = null
      window.removeEventListener('pointermove', remember, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [preview, dismissTip])

  const chapter = (n: number) => {
    const sp = specialAt(layout, n)
    const i = sp && layout ? n - layout.main - 1 : n - 1
    // 弹窗打开时周档也可能换版：旧手帐分组与新索引不合时，宁可少显示资料也不贴错集
    const row = sp ? details?.specials[i] : details?.main[i]
    const detail = (!layout || details?.main.length === layout.main) && (!sp || sp.sort === row?.sort) ? row : undefined
    const sort = sp ? sp.sort ?? i + 1 : (detail?.sort ?? n)
    return { sp, detail, sort, label: `${sp ? 'SP' : 'EP'} ${sort}` }
  }
  const active = preview && chapter(preview.position)
  return <div className="ge-grid" role="group" aria-label="全部章节">
    {Array.from({ length: count }, (_, i) => {
      const n = i + 1, { sp, sort, label } = chapter(n)
      const button = <button type="button" className={`ge-ep${marked.has(n) ? ' on' : ''}`}
        data-position={n} aria-label={label} aria-pressed={marked.has(n)} aria-describedby={preview?.position === n ? tipId : undefined}
        onPointerEnter={e => { if (e.pointerType === 'mouse') mouseOver(n, e.currentTarget, e.clientX, e.clientY) }}
        onPointerLeave={e => { if (e.pointerType === 'mouse') leave() }}
        onFocus={e => { if (e.currentTarget.matches(':focus-visible')) show(n, e.currentTarget) }}
        onBlur={() => setPreview(null)}
        onPointerDown={e => {
          held.current = null
          endHold()
          if (e.pointerType === 'mouse') return
          const anchor = e.currentTarget
          touch.current = { x: e.clientX, y: e.clientY }
          holdTimer.current = window.setTimeout(() => { held.current = anchor; show(n, anchor) }, 450)
        }}
        onPointerMove={e => {
          if (e.pointerType === 'mouse') mouseOver(n, e.currentTarget, e.clientX, e.clientY)
          if (touch.current && Math.hypot(e.clientX - touch.current.x, e.clientY - touch.current.y) > 8) endHold()
        }}
        onPointerUp={endHold} onPointerCancel={endHold} onContextMenu={e => { if (touch.current || held.current) e.preventDefault() }}
        onClick={e => {
          if (held.current === e.currentTarget && e.detail !== 0) { held.current = null; return }
          onToggle(n)
        }}>
        {String(sort).padStart(2, '0')}{marked.has(n) && notes[n] && <span className="ge-ep-dot" />}
      </button>
      return sp && i === layout?.main
        ? <span key={n} className="ge-sp-start"><span className="ge-sp-label" aria-hidden="true">SP</span>{button}</span>
        : <Fragment key={n}>{button}</Fragment>
    })}
    {preview && active && <EpisodeTip id={tipId} preview={preview} label={active.label} detail={active.detail}
      fallback={active.detail?.nameCn ? undefined : active.sp?.title} status={status} note={notes[preview.position]} onEnter={cancelHide} onLeave={leave} />}
  </div>
}
