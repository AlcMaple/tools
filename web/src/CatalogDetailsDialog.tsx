import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchCatalogDetails, type CatalogDetails, type CatalogItem } from './api'
import { Ic, Spinner } from './SketchIcon'

export function CatalogDetailsDialog({ id, onClose, canTrack, tracked, trackError, onTrack, onWatch }: {
  id: number
  onClose: () => void
  canTrack: boolean
  tracked: boolean
  trackError: string | null
  onTrack: (item: CatalogItem) => void
  onWatch: (item: CatalogItem) => void
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [detail, setDetail] = useState<CatalogDetails | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const el = dialog.current!
    const previous = document.activeElement
    el.showModal()
    const ctl = new AbortController()
    void fetchCatalogDetails(id, ctl.signal).then(result => {
      if (!ctl.signal.aborted) setDetail(result)
    }).catch((e: Error) => { if (!ctl.signal.aborted) setError(e.message) })
    return () => {
      ctl.abort()
      el.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [id])
  const item = detail?.item
  return createPortal(
    <dialog ref={dialog} className="dlg catalog-details" aria-labelledby="catalog-details-title" onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose() } }}>
      <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭作品简介" autoFocus><Ic name="x" cls="ic" /></button>
      <header className="catalog-details-head">
        <span className="font-hand muted">作品简介</span>
        <h2 id="catalog-details-title">{item ? item.nameCn || item.name : '作品资料'}</h2>
        {item && <p className="muted small">{[item.date, item.eps > 0 ? `${item.eps} 集` : '', item.score > 0 ? `★ ${item.score.toFixed(1)}` : ''].filter(Boolean).join(' · ')}</p>}
      </header>
      <div className="catalog-details-body" aria-live="polite" aria-busy={!detail && !error}>
        {error ? <p className="form-note err" role="alert">{error}</p> : !detail ? <p className="row"><Spinner size={20} />正在读取作品资料…</p> : <>
          {(item?.name !== item?.nameCn || detail.aliases.length > 0) && <dl className="catalog-details-names">
            {item?.name !== item?.nameCn && <><dt>原名</dt><dd>{item?.name}</dd></>}
            {detail.aliases.length > 0 && <><dt>别名</dt><dd>{detail.aliases.join(' / ')}</dd></>}
          </dl>}
          {item && item.tags.length > 0 && <div className="catalog-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
          <h3>简介</h3>
          {detail.summaryStatus === 'available' ? <p className="catalog-details-summary">{detail.summary}</p> : <p className="muted">{detail.summaryStatus === 'empty' ? '这部作品暂时没有简介' : '简介暂未就绪'}</p>}
        </>}
      </div>
      <footer className="catalog-details-actions">
        {trackError && <p className="catalog-details-status" role="alert">{trackError}</p>}
        {item && <>
          <button type="button" className="btn btn-primary" onClick={() => onWatch(item)}><Ic name="play" cls="ic ic-sm" />{canTrack ? '观看' : '登录后观看'}</button>
          {canTrack && <button type="button" className="btn" disabled={tracked} onClick={() => onTrack(item)}>{tracked ? '已在追番' : '加入想看'}</button>}
        </>}
        <button type="button" className="btn btn-ghost" onClick={onClose}>返回列表</button>
      </footer>
    </dialog>, document.body,
  )
}
