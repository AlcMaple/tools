import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from './auth'
import { CatalogDownloads } from './CatalogDownloads'
import { Ic } from './SketchIcon'

export function CatalogDialog({ section, title, meta, busy, children, actions, trigger, onClose }: {
  section: '下载资源' | '作品简介'
  title: string
  meta?: string
  busy?: boolean
  children: ReactNode
  actions?: ReactNode
  trigger?: HTMLButtonElement
  onClose: () => void
}): JSX.Element | null {
  const dialog = useRef<HTMLDialogElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const { user } = useAuth()
  const openerAccount = useRef(user?.id)
  const sameAccount = openerAccount.current === user?.id
  useEffect(() => { if (!sameAccount) onClose() }, [sameAccount, onClose])
  useEffect(() => {
    if (!sameAccount) return
    const el = dialog.current!
    const previous = trigger ?? document.activeElement
    el.showModal()
    return () => {
      el.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [sameAccount, trigger])
  useEffect(() => { body.current?.scrollTo(0, 0) }, [section])
  if (!sameAccount) return null
  return createPortal(
    <dialog ref={dialog} className="dlg catalog-details" aria-labelledby={titleId}
      onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}
      onCancel={e => { e.preventDefault(); onClose() }}
      onClick={e => {
        if (e.target !== e.currentTarget) return
        const r = e.currentTarget.getBoundingClientRect()
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose()
      }}>
      <button type="button" className="dlg-close" onClick={onClose} aria-label={`关闭${section}`} autoFocus><Ic name="x" cls="ic" /></button>
      <header className="catalog-details-head">
        <span className="font-hand muted">{section}</span>
        <h2 id={titleId}>{title}</h2>
        {meta && <p className="muted small">{meta}</p>}
      </header>
      <div ref={body} className="catalog-details-body" aria-live={section === '作品简介' ? 'polite' : 'off'} aria-busy={busy}>
        {children}
      </div>
      <footer className="catalog-details-actions">
        {actions}
        <button type="button" className="btn btn-ghost" onClick={onClose}>{actions ? '返回列表' : '返回'}</button>
      </footer>
    </dialog>, document.body,
  )
}

type DownloadSubject = { id: number; title: string; season?: string }

export function CatalogDownloadDialog({ id, title, season, trigger, onClose }: DownloadSubject & {
  trigger: HTMLButtonElement
  onClose: () => void
}): JSX.Element {
  return <CatalogDialog section="下载资源" title={title} trigger={trigger} onClose={onClose}>
    <CatalogDownloads key={`${id}:${season ?? ''}`} id={id} season={season} />
  </CatalogDialog>
}

export function CatalogDownloadButton({ id, title, season }: DownloadSubject): JSX.Element | null {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  if (id <= 0) return null
  return <>
    <button type="button" className="download-entry" aria-haspopup="dialog" aria-label={`下载《${title}》的资源`} onClick={e => setTrigger(e.currentTarget)}>
      <Ic name="download" cls="ic ic-sm" />下载
    </button>
    {trigger && <CatalogDownloadDialog id={id} title={title} season={season} trigger={trigger} onClose={() => setTrigger(null)} />}
  </>
}
