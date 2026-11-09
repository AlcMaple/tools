import { useEffect, useRef, useState } from 'react'
import { fetchCatalogGenres, saveCatalogGenres, type CatalogGenre } from './api'
import './styles/catalog-discovery.css'

export interface DiscoveryFilters { include: string[]; exclude: string[] }
type Field = 'include' | 'exclude'
const parse = (value: string): string[] => [...new Set(value.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean))]
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i])
// 一百多个题材全铺开会把目录推到第二屏，先露出最常见的这些
const FOLDED = 20

export function CatalogDiscovery({ value, genres, admin, onApply, onGenresSaved }: {
  value: DiscoveryFilters
  genres: string[]
  admin: boolean
  onApply: (value: DiscoveryFilters) => void
  onGenresSaved: () => void
}): JSX.Element {
  const [include, setInclude] = useState(value.include.join('，'))
  const [exclude, setExclude] = useState(value.exclude.join('，'))
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [managing, setManaging] = useState(false)
  // 点题材时输入框已经失焦了，所以记的是「最后聚焦的那个框」；还没聚焦过就进「同时包含」
  const target = useRef<Field>('include')
  const active = value.include.length + value.exclude.length > 0

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = { include: parse(include), exclude: parse(exclude) }
      if ([next.include, next.exclude].some(tags => tags.length > 5 || tags.some(tag => tag.length > 20))) return setError('每组最多5个题材，每个不超过20字')
      if (next.include.some(tag => next.exclude.includes(tag))) return setError('同一题材不要同时包含和排除')
      setError('')
      if (!same(next.include, value.include) || !same(next.exclude, value.exclude)) onApply(next)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [include, exclude])

  const toggle = (tag: string): void => {
    const into = target.current
    const mine = parse(into === 'include' ? include : exclude)
    const other = parse(into === 'include' ? exclude : include)
    const nextMine = mine.includes(tag) ? mine.filter(t => t !== tag) : [...mine, tag]
    const nextOther = other.filter(t => t !== tag)
    ;(into === 'include' ? setInclude : setExclude)(nextMine.join('，'))
    ;(into === 'include' ? setExclude : setInclude)(nextOther.join('，'))
  }
  const included = parse(include), excluded = parse(exclude)
  const shown = expanded ? genres : genres.slice(0, FOLDED)

  return <section className="catalog-discovery" aria-label="按题材找番">
    <div className="catalog-discovery-heading"><h2>按题材找番</h2>
      <div className="catalog-discovery-status" aria-live="polite">{error ? <span className="err">{error}</span> : active
        ? <span>{value.include.length ? `同时包含 ${value.include.join(' + ')}` : ''}{value.include.length && value.exclude.length ? '；' : ''}{value.exclude.length ? `排除 ${value.exclude.join('、')}` : ''}</span>
        : null}</div>
      {admin && <button type="button" className="btn btn-sm" onClick={() => setManaging(on => !on)} aria-expanded={managing}>{managing ? '收起管理' : '管理题材'}</button>}
    </div>
    <div className="catalog-discovery-fields">
      <label>同时包含<input value={include} onFocus={() => { target.current = 'include' }} onChange={event => setInclude(event.target.value)} placeholder="例如：日常，搞笑" maxLength={110} /></label>
      <label>排除题材<input value={exclude} onFocus={() => { target.current = 'exclude' }} onChange={event => setExclude(event.target.value)} placeholder="例如：恋爱" maxLength={110} /></label>
      <button className="btn" type="button" disabled={!include && !exclude} onClick={() => { setInclude(''); setExclude(''); setError(''); target.current = 'include' }}>清空题材</button>
    </div>
    {genres.length > 0 && <div className="catalog-discovery-suggestions" aria-label="常用题材">
      {shown.map(tag => {
        const state = included.includes(tag) ? 'in' : excluded.includes(tag) ? 'out' : undefined
        return <button type="button" key={tag} data-state={state} aria-pressed={!!state} title={state === 'out' ? `排除 ${tag}` : undefined} onMouseDown={event => event.preventDefault()} onClick={() => toggle(tag)}>{tag}</button>
      })}
      {genres.length > FOLDED && <button type="button" className="catalog-discovery-more" onClick={() => setExpanded(on => !on)}>{expanded ? '收起' : `更多 ${genres.length - FOLDED}`}</button>}
    </div>}
    {admin && managing && <GenreManager onSaved={onGenresSaved} />}
  </section>
}

function GenreManager({ onSaved }: { onSaved: () => void }): JSX.Element {
  const [rows, setRows] = useState<CatalogGenre[] | null>(null)
  const [draft, setDraft] = useState<Map<string, boolean>>(new Map())
  const [state, setState] = useState<{ busy: boolean; note: string; err: boolean }>({ busy: false, note: '', err: false })

  useEffect(() => {
    const ctl = new AbortController()
    fetchCatalogGenres(ctl.signal).then(setRows).catch((e: Error) => { if (!ctl.signal.aborted) setState({ busy: false, note: e.message, err: true }) })
    return () => ctl.abort()
  }, [])

  const visible = (row: CatalogGenre): boolean => draft.get(row.tag) ?? row.visible
  const changed = rows ? rows.filter(row => draft.has(row.tag) && draft.get(row.tag) !== row.visible) : []
  const save = (): void => {
    setState({ busy: true, note: '', err: false })
    saveCatalogGenres(changed.map(row => ({ tag: row.tag, visible: visible(row) })))
      .then(next => { setRows(next); setDraft(new Map()); setState({ busy: false, note: '已保存', err: false }); onSaved() })
      .catch((e: Error) => setState({ busy: false, note: e.message, err: true }))
  }

  return <div className="genre-manager">
    <div className="genre-manager-bar">
      <span className={`genre-manager-count${state.err ? ' err' : ''}`} aria-live="polite">{state.err ? state.note : rows ? `收录 100 部以上的标签 ${rows.length} 个，显示 ${rows.filter(visible).length} 个` : '读取中…'}</span>
      <button type="button" className="btn btn-sm primary" disabled={state.busy || changed.length === 0} onClick={save}>{state.busy ? '保存中…' : changed.length ? `保存 ${changed.length} 项` : state.note === '已保存' ? '已保存' : '保存'}</button>
    </div>
    {rows && <ul className="genre-manager-list">
      {rows.map(row => <li key={row.tag}>
        <label className={visible(row) ? '' : 'is-hidden'}>
          <input type="checkbox" checked={visible(row)} onChange={event => { setDraft(prev => new Map(prev).set(row.tag, event.target.checked)); setState({ busy: false, note: '', err: false }) }} />
          <span className="genre-manager-tag">{row.tag}</span>
          <span className="genre-manager-num">{row.count.toLocaleString()}</span>
        </label>
      </li>)}
    </ul>}
  </div>
}
