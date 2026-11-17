import { useEffect, useRef, useState } from 'react'
import { coverUrl, fetchRelatedAnime, type CatalogItem, type RelatedAnimeResult, type Track } from './api'
import { useAuth } from './auth'
import { Ic, Spinner } from './SketchIcon'
import './styles/related-anime.css'

type Load = { id: number; owner: number | null; data?: RelatedAnimeResult; error?: string }
const statusLabel = { watching: '在看', plan: '想看', considering: '观望', done: '看完' }

export function RelatedAnimeDialog({ id, tracks, onAdd, onClose }: {
  id: number; tracks: Map<number, Track>; onAdd: (item: CatalogItem) => void; onClose: () => void
}): JSX.Element {
  const { user } = useAuth()
  const owner = user?.id ?? null
  const [path, setPath] = useState([id])
  const current = path[path.length - 1]
  const [load, setLoad] = useState<Load | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  // 切换账号时在渲染阶段隔开旧结果，避免请求重跑前闪出上一身份可见的标题
  const data = load?.owner === owner && load.id === current ? load.data : undefined
  const error = load?.owner === owner && load.id === current ? load.error : undefined
  useEffect(() => { closeButton.current?.focus() }, [current])
  useEffect(() => {
    const controller = new AbortController()
    void fetchRelatedAnime(current, controller.signal).then(data => {
      if (!controller.signal.aborted) setLoad({ id: current, owner, data })
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setLoad({ id: current, owner, error: error.message })
    })
    return () => controller.abort()
  }, [current, owner])
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButton.current?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close.current()
      if (event.key !== 'Tab') return
      const buttons = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? [])]
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', keydown)
    return () => { window.removeEventListener('keydown', keydown); before?.focus() }
  }, [])
  const groups = [...new Set(data?.items.map(item => item.relation) ?? [])]
  return <div className="dlg-backdrop open" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={panel} className="dlg related-anime" role="dialog" aria-modal="true" aria-labelledby="related-title">
      <button ref={closeButton} className="dlg-close" type="button" aria-label="关闭相关作品" onClick={onClose}><Ic name="x" cls="ic" /></button>
      <h2 id="related-title" className="dlg-title">相关作品</h2>
      {path.length > 1 && <button className="btn btn-sm" type="button" onClick={() => setPath(prev => prev.slice(0, -1))}>返回上一部</button>}
      {data && <h3 className="related-source">{data.source.nameCn || data.source.name}</h3>}
      <p className="muted small">按作品关系分组，不代表推荐观看顺序</p>
      <div className="related-body" aria-live="polite">
        {!data && !error && <Spinner size={28} />}
        {error && <p className="form-note err">{error}</p>}
        {data && !data.ready && <p>关联资料还没准备好，仍可返回目录找番</p>}
        {data?.ready && !data.items.length && <p>暂时没有收录相关动画</p>}
        {groups.map(group => <section key={group} className="related-group"><h3>{group}</h3>
          {data?.items.filter(item => item.relation === group).map(item => {
            const track = tracks.get(item.bgmId)
            return <article key={item.bgmId} className="related-card">
              {item.cover ? <img src={coverUrl(item.cover, item.bgmId)} alt="" loading="lazy" /> : <span className="related-cover" aria-hidden="true">☆</span>}
              <div><h4>{item.nameCn || item.name}</h4><p className="muted small">{item.date || '日期未收录'}{item.eps ? ` · ${item.eps} 集` : ''}</p>
                <div className="related-actions"><button className="btn btn-sm" type="button" onClick={() => setPath(prev => [...prev, item.bgmId])}>查看关联</button>
                  {track ? <span className="small">{statusLabel[track.status]} · 第 {track.episode} 集</span> : user ? <button className="btn btn-sm btn-primary" type="button" onClick={() => onAdd(item)}>加入想看</button> : <span className="small muted">登录后可加入想看</span>}
                </div>
              </div>
            </article>
          })}
        </section>)}
        {data?.truncated && <p className="small muted">关联较多，当前显示前200项</p>}
      </div>
    </div>
  </div>
}
