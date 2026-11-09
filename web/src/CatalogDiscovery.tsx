import { useState } from 'react'
import './styles/catalog-discovery.css'

export interface DiscoveryFilters { include: string[]; exclude: string[] }
const suggestions = ['日常', '喜剧', '治愈', '恋爱', '冒险', '科幻', '校园', '悬疑']
const parse = (value: string): string[] => [...new Set(value.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean))]

export function CatalogDiscovery({ value, onApply }: { value: DiscoveryFilters; onApply: (value: DiscoveryFilters) => void }): JSX.Element {
  const [include, setInclude] = useState(value.include.join('，'))
  const [exclude, setExclude] = useState(value.exclude.join('，'))
  const [error, setError] = useState('')
  const active = value.include.length + value.exclude.length > 0
  const apply = (): void => {
    const next = { include: parse(include), exclude: parse(exclude) }
    if ([next.include, next.exclude].some(tags => tags.length > 5 || tags.some(tag => tag.length > 20))) {
      setError('每组最多5个题材，每个不超过20字')
      return
    }
    if (next.include.some(tag => next.exclude.includes(tag))) {
      setError('同一题材不要同时包含和排除')
      return
    }
    setError('')
    onApply(next)
  }
  return <section className="catalog-discovery" aria-label="按题材找番">
    <div className="catalog-discovery-heading"><h2>按题材找番</h2><span>不知道番名，也能从想看的题材开始</span></div>
    <form onSubmit={event => { event.preventDefault(); apply() }}>
      <div className="catalog-discovery-fields">
        <label>同时包含<input value={include} onChange={event => setInclude(event.target.value)} placeholder="例如：日常，喜剧" maxLength={110} /></label>
        <label>排除题材<input value={exclude} onChange={event => setExclude(event.target.value)} placeholder="例如：恋爱" maxLength={110} /></label>
        <button className="btn primary" type="submit">找番</button>
        <button className="btn" type="button" onClick={() => { setInclude(''); setExclude(''); setError(''); onApply({ include: [], exclude: [] }) }}>清空题材</button>
      </div>
      <div className="catalog-discovery-suggestions" aria-label="常用题材">
        {suggestions.map(tag => <button type="button" key={tag} aria-pressed={parse(include).includes(tag)} onClick={() => {
          const tags = parse(include)
          setInclude((tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag]).join('，'))
        }}>{tag}</button>)}
      </div>
      <div className="catalog-discovery-status" aria-live="polite">{error ? <span className="err">{error}</span> : active
        ? <span>{value.include.length ? `同时包含 ${value.include.join(' + ')}` : ''}{value.include.length && value.exclude.length ? '；' : ''}{value.exclude.length ? `排除 ${value.exclude.join('、')}` : ''}</span>
        : <span>多个题材用逗号分开，按已收录标签匹配</span>}</div>
    </form>
  </section>
}
