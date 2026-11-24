import { useEffect, useState } from 'react'
import { fetchCatalogDetails, type CatalogDetails, type CatalogItem } from './api'
import { Ic, Spinner } from './SketchIcon'
import { CatalogDownloads } from './CatalogDownloads'
import { CatalogDialog } from './CatalogDialog'

export function CatalogDetailsDialog({ id, onClose, canTrack, tracked, trackError, onTrack, onWatch }: {
  id: number
  onClose: () => void
  canTrack: boolean
  tracked: boolean
  trackError: string | null
  onTrack: (item: CatalogItem) => void
  onWatch: (item: CatalogItem) => void
}): JSX.Element {
  const [detail, setDetail] = useState<CatalogDetails | null>(null)
  const [error, setError] = useState('')
  const [downloads, setDownloads] = useState(false)
  useEffect(() => {
    const ctl = new AbortController()
    void fetchCatalogDetails(id, ctl.signal).then(result => {
      if (!ctl.signal.aborted) setDetail(result)
    }).catch((e: Error) => { if (!ctl.signal.aborted) setError(e.message) })
    return () => ctl.abort()
  }, [id])
  const item = detail?.item
  return (
    <CatalogDialog section={downloads ? '下载资源' : '作品简介'} title={item ? item.nameCn || item.name : '作品资料'}
      meta={item && [item.date, item.eps > 0 ? `${item.eps} 集` : '', item.score > 0 ? `★ ${item.score.toFixed(1)}` : ''].filter(Boolean).join(' · ')}
      busy={!detail && !error} onClose={onClose} actions={<>
        {trackError && <p className="catalog-details-status" role="alert">{trackError}</p>}
        {item && !downloads && <>
          <button type="button" className="btn btn-primary" onClick={() => onWatch(item)}><Ic name="play" cls="ic ic-sm" />{canTrack ? '观看' : '登录后观看'}</button>
          {canTrack && <button type="button" className="btn" disabled={tracked} onClick={() => onTrack(item)}>{tracked ? '已在追番' : '加入想看'}</button>}
        </>}
        {item && <button type="button" className="btn" onClick={() => setDownloads(open => !open)}><Ic name={downloads ? 'back' : 'download'} cls="ic ic-sm" />{downloads ? '返回简介' : '下载资源'}</button>}
      </>}>
        {downloads && item ? <CatalogDownloads id={id} /> : error ? <p className="form-note err" role="alert">{error}</p> : !detail ? <p className="row"><Spinner size={20} />正在读取作品资料…</p> : <>
          {(item?.name !== item?.nameCn || detail.aliases.length > 0) && <dl className="catalog-details-names">
            {item?.name !== item?.nameCn && <><dt>原名</dt><dd>{item?.name}</dd></>}
            {detail.aliases.length > 0 && <><dt>别名</dt><dd>{detail.aliases.join(' / ')}</dd></>}
          </dl>}
          {item && item.tags.length > 0 && <div className="catalog-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
          <h3>简介</h3>
          {detail.summaryStatus === 'available' ? <p className="catalog-details-summary">{detail.summary}</p> : <p className="muted">{detail.summaryStatus === 'empty' ? '这部作品暂时没有简介' : '简介暂未就绪'}</p>}
        </>}
    </CatalogDialog>
  )
}
