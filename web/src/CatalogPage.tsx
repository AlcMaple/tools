// 全部番剧 —— 离线索引里的整张动画表，皮肤沿用周历的拍立得海报墙（纵向排布）。
// 封面由服务端后台慢慢补，没补到的就是纸片占位；这一页从不让浏览触发 BGM 请求。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogItem, CalendarItem } from './api'
import { coverUrl, fetchCatalog, sourceById } from './api'
import { Poster, type PosterWatch } from './CalendarPage'
import { CatalogEditDialog } from './CatalogEditDialog'
import { CatalogDetailsDialog } from './CatalogDetailsDialog'
import { requestAnimeWatch } from './FindAnime'
import { Select } from './Select'
import { Ic, Spinner } from './SketchIcon'
import { useSourceWatch } from './tracks/useSourceWatch'
import { useTrackToggle } from './useTrackToggle'
import { CatalogDiscovery, type DiscoveryFilters } from './CatalogDiscovery'
import { useAuth } from './auth'

const PAGE = 48
type Sort = 'score' | 'date'

// 只记住本次打开网站时的筛选
let lastView: { query: string; year: number; sort: Sort; discovery: DiscoveryFilters } = { query: '', year: 0, sort: 'score', discovery: { include: [], exclude: [] } }

// 切回看过的条件（比如 2027 年 → 全部年份）先把上次的列表原样摆出来，同时照常重新请求覆盖；
// 键里带账号，退出登录后不会把只给登录用户看的条目摆给访客
interface CachedView { items: CatalogItem[]; total: number; ready: boolean; admin: boolean; genres: string[] }
const viewCache = new Map<string, CachedView>()
const VIEW_CACHE_MAX = 12

const thisYear = new Date().getFullYear()
const YEAR_OPTIONS = [
  { id: '0', text: '全部年份' },
  ...Array.from({ length: thisYear - 1960 + 2 }, (_, i) => String(thisYear + 1 - i)).map((y) => ({ id: y, text: `${y} 年` })),
]

function asCalendarItem(item: CatalogItem): CalendarItem {
  return { id: item.bgmId, name: item.name, name_cn: item.nameCn, url: '', cover: item.cover, airDate: item.date, episodes: item.eps, score: item.score }
}

function metaOf(item: CatalogItem): string {
  const year = /^\d{4}/.exec(item.date)?.[0]
  return [year && Number(year) > 0 ? `${year} 年` : '', item.eps > 0 ? `${item.eps} 集` : '', item.score > 0 ? `★ ${item.score.toFixed(1)}` : '']
    .filter(Boolean).join(' · ') || '未定档'
}

export function CatalogPage(): JSX.Element {
  const [query, setQuery] = useState(lastView.query)
  const [q, setQ] = useState(lastView.query.trim())
  const [year, setYear] = useState(lastView.year)
  const [sort, setSort] = useState<Sort>(lastView.sort)
  const [discovery, setDiscovery] = useState(lastView.discovery)
  const [stale, setStale] = useState(false)
  const [genres, setGenres] = useState<string[]>([])
  const { user } = useAuth()
  const viewKey = JSON.stringify([user?.id ?? 0, q, year, sort, discovery])
  const [admin, setAdmin] = useState(false)
  const [details, setDetails] = useState<{ id: number; owner: number } | null>(null)
  useEffect(() => { setDetails(null) }, [user?.id])
  const [editing, setEditing] = useState<CatalogItem | null>(null)
  const [items, setItems] = useState<CatalogItem[]>([])
  const [total, setTotal] = useState(0)
  const [ready, setReady] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)

  const track = useTrackToggle()
  const sourceWatch = useSourceWatch(setError)
  const posterWatch: PosterWatch = {
    tracksById: track.tracksById,
    bindings: sourceWatch.bindings,
    locating: sourceWatch.locating,
    onContinue: (t, source, mode, rebind) => sourceWatch.continueWatch(sourceById(source), t, mode, rebind),
  }

  useEffect(() => {
    lastView = { query, year, sort, discovery }
  }, [query, year, sort, discovery])

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = (offset: number): void => {
    controller.current?.abort()
    const ctl = new AbortController()
    controller.current = ctl
    const gen = offset === 0 ? ++generation.current : generation.current
    setLoading(true)
    setError(null)
    if (offset === 0) {
      const cached = viewCache.get(viewKey)
      if (cached) {
        setReady(cached.ready)
        setAdmin(cached.admin)
        setGenres(cached.genres)
        setTotal(cached.total)
        setItems(cached.items)
      }
      setStale(!cached)
    }
    const key = viewKey
    fetchCatalog({ q, year, sort, offset, limit: PAGE, ...discovery }, ctl.signal)
      .then((r) => {
        if (gen !== generation.current) return
        setStale(false)
        setReady(r.ready)
        setAdmin(r.admin)
        setGenres(r.genres)
        setTotal(r.total)
        setItems((prev) => {
          const next = offset === 0 ? r.items : [...prev, ...r.items]
          viewCache.delete(key)
          viewCache.set(key, { items: next, total: r.total, ready: r.ready, admin: r.admin, genres: r.genres })
          if (viewCache.size > VIEW_CACHE_MAX) viewCache.delete(viewCache.keys().next().value as string)
          return next
        })
      })
      .catch((e: Error) => {
        if (ctl.signal.aborted) return
        console.warn('[catalog] 读取失败', e)
        setError(e.message)
      })
      .finally(() => { if (controller.current === ctl) { setLoading(false); setStale(false) } })
  }

  useEffect(() => {
    load(0)
    return () => controller.current?.abort()
  }, [viewKey])

  const hasMore = items.length < total
  useEffect(() => {
    const target = moreRef.current
    if (!target || !hasMore || loading || error || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) load(items.length)
    }, { rootMargin: '600px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [hasMore, loading, error, items.length])

  // 页头的扇面跟着当前列表走：筛了年份 / 搜了名字，叠着的就是那几部
  const fan = useMemo(() => items.filter((i) => i.cover).slice(0, 3), [items])

  const summary = useMemo(() => {
    if (!ready) return ''
    if (q) return `搜到 ${total} 部`
    return `${year > 0 ? `${year} 年 · ` : ''}共 ${total.toLocaleString()} 部`
  }, [ready, q, year, total])

  return (
    <div className={`catalog-page${fan.length ? '' : ' no-art'}`}>
      {details && details.owner === (user?.id ?? 0) && <CatalogDetailsDialog
        key={`${details.owner}:${details.id}`} id={details.id} onClose={() => setDetails(null)}
        canTrack={track.canTrack} tracked={track.tracked.has(details.id)} trackError={track.error}
        onTrack={item => track.toggle(asCalendarItem(item), 0, 'plan')}
        onWatch={item => { setDetails(null); requestAnimeWatch(asCalendarItem(item)) }}
      />}
      <header className="sketch-hero">
        <div className="sketch-hero-body">
          <div>
            <h1 className="title-sketch" style={{ fontSize: 34 }}>全部番剧</h1>
            <p className="muted small mt8">{summary || ' '}</p>
          </div>
          <div className="row catalog-toolbar">
            <div className="searchbar">
              <Ic name="search" cls="ic" />
              <input
                spellCheck={false}
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜番名、日文名或别名…"
                aria-label="搜索全部番剧"
              />
              {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清空搜索"><Ic name="x" cls="ic ic-sm" /></button>}
            </div>
            <div className="catalog-year">
              <Select options={YEAR_OPTIONS} value={String(year)} onChange={(id) => setYear(Number(id))} placeholder="全部年份" />
            </div>
            <div className="seg" role="group" aria-label="排序">
              <button type="button" className={sort === 'score' ? 'on' : ''} aria-pressed={sort === 'score'} onClick={() => setSort('score')}>评分</button>
              <button type="button" className={sort === 'date' ? 'on' : ''} aria-pressed={sort === 'date'} onClick={() => setSort('date')}>最新</button>
            </div>
          </div>
        </div>
        {fan.length > 0 && (
          <div className="catalog-fan" aria-hidden="true">
            {fan.map((item) => <img key={item.bgmId} src={coverUrl(item.cover, item.bgmId)} alt="" draggable={false} />)}
          </div>
        )}
      </header>

      <CatalogDiscovery value={discovery} genres={genres} admin={admin} onApply={setDiscovery} onGenresSaved={() => { viewCache.clear(); load(0) }} />
      {sourceWatch.modals}
      {editing && (
        <CatalogEditDialog
          item={editing}
          onSaved={(next) => {
            // 只有手改过的标签是完整列表（索引标签回给前端时截了前 6 个），据此判断；改了标签可能不再符合题材条件：原地拿掉这一张，不重读目录，免得丢滚动位置
            const stillMatches = !next.edited?.tags || discovery.include.every((t) => next.tags.includes(t)) && !discovery.exclude.some((t) => next.tags.includes(t))
            setItems((prev) => stillMatches ? prev.map((i) => (i.bgmId === next.bgmId ? next : i)) : prev.filter((i) => i.bgmId !== next.bgmId))
            if (!stillMatches) setTotal((n) => Math.max(0, n - 1))
            viewCache.clear()
            setEditing(next)
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {(error || track.error) && (
        <p className="form-note err mt8" aria-live="polite">⚠ {error ?? track.error}</p>
      )}

      {!ready ? (
        <div className="page-state"><p className="faint small">番剧目录还没整理好，晚点再来</p></div>
      ) : items.length === 0 && loading ? (
        <div className="page-state"><Spinner size={36} /><p className="faint small">纱雾正在翻目录…</p></div>
      ) : items.length === 0 && !error ? (
        <div className="page-state"><p className="faint small">{discovery.include.length || discovery.exclude.length ? '没有符合这些条件的番，试着减少题材或清空题材筛选' : q ? (year > 0 ? `没有找到 ${year} 年的「${q}」` : `没有找到「${q}」，换个名字试试`) : '这一年没有收录的番'}</p></div>
      ) : (
        <div className={`film is-vertical catalog-grid${stale ? ' is-stale' : ''}`} aria-busy={stale}>
          {items.map((item) => (
            <Poster
              key={item.bgmId}
              item={asCalendarItem(item)}
              weekday={0}
              canTrack={track.canTrack}
              tracked={track.tracked.has(item.bgmId)}
              onToggle={(i, w) => track.toggle(i, w, 'plan')}
              watch={posterWatch}
              meta={metaOf(item)}
              onDetails={() => setDetails({ id: item.bgmId, owner: user?.id ?? 0 })}
              details={item.tags.length > 0 ? <div className="catalog-tags">{[...new Set(item.tags)].map(tag => <span key={tag}>{tag}</span>)}</div> : undefined}
              coverExtra={admin && (
                <button type="button" className="catalog-edit-btn" onClick={() => setEditing(item)} aria-label="编辑卡片" title="编辑卡片">
                  <Ic name="pencil" cls="ic ic-sm" />
                </button>
              )}
            />
          ))}
        </div>
      )}

      {hasMore && (
        <div ref={moreRef} className="trk-more">
          {loading ? <Spinner size={24} /> : (
            <button type="button" className="btn btn-ghost" onClick={() => load(items.length)}>加载更多</button>
          )}
        </div>
      )}
    </div>
  )
}
