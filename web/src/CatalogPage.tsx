// 全部番剧 —— 离线索引里的整张动画表，皮肤沿用周历的拍立得海报墙（纵向排布）。
// 封面由服务端后台慢慢补，没补到的就是纸片占位；这一页从不让浏览触发 BGM 请求。
import { useEffect, useMemo, useRef, useState } from 'react'
import { isCatalogBookmark, type CatalogBookmark, type CatalogFilters } from '../shared/catalog-position'
import type { CatalogItem, CalendarItem, Track } from './api'
import { coverUrl, fetchCatalog, sourceById, SOURCES } from './api'
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
import { RelatedAnimeDialog } from './RelatedAnimeDialog'
import { CatalogGrid } from './CatalogGrid'
import { WatchSourceDialog } from './tracks/TrackCard'
import { watchEp } from './tracks/common'

const PAGE = 48

const DEFAULT_FILTERS: CatalogFilters = { year: 0, sort: 'score', include: [], exclude: [], maxEps: 0, finished: false }
// 手动选择与搜索仍在本次打开网站时沿用，从书签带回的条件不变成下次进页的默认值
const lastFilters = new Map<number, CatalogFilters>()
const lastQueries = new Map<number, string>()
const filterKey = (owner: number, q: string, filters: CatalogFilters): string =>
  JSON.stringify([owner, q, filters.year, filters.sort, filters.include, filters.exclude, filters.maxEps, filters.finished])

function readBookmark(key: string): CatalogBookmark | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return isCatalogBookmark(raw) ? raw : null
  } catch { return null }
}

// 切回看过的条件先显示首批再刷新，其他筛选不累积整份浏览历史；
// 键里带账号，退出登录后不会把只给登录用户看的条目摆给访客
interface CachedView { items: CatalogItem[]; total: number; ready: boolean; admin: boolean; genres: string[]; planningReady: boolean }
const viewCache = new Map<string, CachedView>()
const VIEW_CACHE_MAX = 12
interface CatalogWindow { key: string; start: number; end: number; items: CatalogItem[]; restoreId?: number; revision: number }
const EMPTY_WINDOW: CatalogWindow = { key: '', start: 0, end: 0, items: [], revision: 0 }
type Load = { kind: 'first' | 'before' | 'after' } | { kind: 'resume'; bookmark: CatalogBookmark }

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
  const { user, ready: authReady, error: authError } = useAuth()
  const owner = user?.id ?? 0
  const bookmarkKey = authReady && !authError ? `mapletools-catalog-position-v1:${user?.id ?? 'guest'}` : null
  const [offer, setOffer] = useState<{ key: string; bookmark: CatalogBookmark | null } | null>(null)
  const bookmark = bookmarkKey && offer?.key === bookmarkKey ? offer.bookmark : null
  const [resumeNote, setResumeNote] = useState('')
  const [query, setQuery] = useState(() => lastQueries.get(owner) ?? '')
  const [q, setQ] = useState(() => query.trim())
  const [filters, setFilters] = useState(() => lastFilters.get(owner) ?? DEFAULT_FILTERS)
  const currentFilters = useRef(filters)
  const { year, sort, include, exclude, maxEps, finished } = filters
  const discovery: DiscoveryFilters = useMemo(() => ({ include, exclude }), [include, exclude])
  const updateFilters = (change: Partial<CatalogFilters>): void => {
    const next = { ...currentFilters.current, ...change }
    currentFilters.current = next
    lastFilters.set(owner, next)
    setFilters(next)
  }
  const [planningReady, setPlanningReady] = useState(false)
  const [stale, setStale] = useState(false)
  const [genres, setGenres] = useState<string[]>([])
  const viewKey = filterKey(owner, q, filters)
  const [admin, setAdmin] = useState(false)
  const [details, setDetails] = useState<{ id: number; owner: number } | null>(null)
  useEffect(() => { setDetails(null) }, [user?.id])
  const [editing, setEditing] = useState<CatalogItem | null>(null)
  const [relatedId, setRelatedId] = useState<number | null>(null)
  const [watchChoice, setWatchChoice] = useState<Track | null>(null)
  const [range, setRange] = useState(EMPTY_WINDOW)
  const { items } = range
  const [total, setTotal] = useState(0)
  const [ready, setReady] = useState(true)
  const [loading, setLoading] = useState<Load['kind'] | null>('first')
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const resumedView = useRef<string | null>(null)
  const beforeRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)

  const track = useTrackToggle()
  const sourceWatch = useSourceWatch(setError)
  const watchTarget = watchChoice && (track.tracksById.get(watchChoice.bgmId) ?? watchChoice)
  const posterWatch: PosterWatch = {
    tracksById: track.tracksById,
    bindings: sourceWatch.bindings,
    locating: sourceWatch.locating,
    onOpenSource: setWatchChoice,
    onContinue: (t, source, mode, rebind) => sourceWatch.continueWatch(sourceById(source), t, mode, rebind),
  }

  useEffect(() => {
    if (!bookmarkKey) return
    const refresh = (): void => setOffer({ key: bookmarkKey, bookmark: readBookmark(bookmarkKey) })
    const onStorage = (event: StorageEvent): void => {
      if (event.key === bookmarkKey || event.key === null) refresh()
    }
    refresh()
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [bookmarkKey])

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = (request: Load): void => {
    const { kind } = request
    const resume = request.kind === 'resume' ? request.bookmark : null
    const adjacent = kind === 'before' || kind === 'after'
    if (adjacent && (controller.current || range.key !== viewKey)) return
    controller.current?.abort()
    const ctl = new AbortController()
    controller.current = ctl
    setLoading(kind)
    setError(null)
    if (!adjacent) setResumeNote('')
    const offset = kind === 'before' ? Math.max(0, range.start - PAGE) : kind === 'after' ? range.end : 0
    const limit = kind === 'before' ? range.start - offset : PAGE
    if (kind === 'first') {
      const cached = viewCache.get(viewKey)
      if (cached) {
        setPlanningReady(cached.planningReady)
        setReady(cached.ready)
        setAdmin(cached.admin)
        setGenres(cached.genres)
        setTotal(cached.total)
        setRange(prev => ({ ...EMPTY_WINDOW, key: viewKey, end: cached.items.length, items: cached.items, revision: prev.revision }))
      }
      setStale(!cached)
    }
    const key = viewKey
    fetchCatalog({ ...(resume?.filters ?? filters), q: resume ? '' : q, offset, limit, around: resume?.ids }, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted || controller.current !== ctl) return
        if (resume) {
          if (!r.ready || r.position === undefined || (!r.planningReady && (resume.filters.maxEps > 0 || resume.filters.finished))) {
            setResumeNote('暂时接不上上次的位置，稍后再试')
            return
          }
          if (!r.position) {
            setResumeNote('找不到上次浏览的位置')
            return
          }
          const { id, offset: start } = r.position
          const nextKey = filterKey(owner, '', resume.filters)
          if (nextKey !== key) resumedView.current = nextKey
          currentFilters.current = resume.filters
          setFilters(resume.filters)
          lastQueries.delete(owner)
          setQuery('')
          setQ('')
          setRange(prev => ({ key: nextKey, start, end: start + r.items.length, items: r.items, restoreId: id, revision: prev.revision + 1 }))
        } else if (kind === 'first') {
          viewCache.delete(key)
          viewCache.set(key, { items: r.items.slice(0, PAGE), total: r.total, ready: r.ready, admin: r.admin, genres: r.genres, planningReady: !!r.planningReady })
          if (viewCache.size > VIEW_CACHE_MAX) viewCache.delete(viewCache.keys().next().value as string)
          setRange(prev => ({ ...EMPTY_WINDOW, key, end: r.items.length, items: r.items, revision: prev.revision }))
        } else {
          setRange(prev => {
            const loaded = new Set(prev.items.map(item => item.bgmId))
            const batch = r.items.filter(item => !loaded.has(item.bgmId))
            return kind === 'before'
              ? { ...prev, start: offset, items: [...batch, ...prev.items] }
              : { ...prev, end: offset + r.items.length, items: [...prev.items, ...batch] }
          })
        }
        setPlanningReady(!!r.planningReady)
        if (!resume && !r.planningReady && (maxEps > 0 || finished)) updateFilters({ maxEps: 0, finished: false })
        setStale(false)
        setReady(r.ready)
        setAdmin(r.admin)
        setGenres(r.genres)
        setTotal(r.total)
      })
      .catch((e: Error) => {
        if (ctl.signal.aborted) return
        console.warn('[catalog] 读取失败', e)
        if (resume) setResumeNote(e.message)
        else setError(e.message)
      })
      .finally(() => {
        if (controller.current !== ctl) return
        controller.current = null
        setLoading(null)
        setStale(false)
      })
  }

  useEffect(() => {
    if (resumedView.current === viewKey) resumedView.current = null
    else load({ kind: 'first' })
  }, [viewKey])
  useEffect(() => () => controller.current?.abort(), [])

  const hasBefore = range.key === viewKey && range.start > 0
  const hasMore = range.key === viewKey && range.end < total
  useEffect(() => {
    const before = beforeRef.current, after = moreRef.current
    if ((!hasBefore && !hasMore) || loading || error || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.target === before && e.isIntersecting)) load({ kind: 'before' })
      if (entries.some(e => e.target === after && e.isIntersecting)) load({ kind: 'after' })
    }, { rootMargin: '600px 0px' })
    if (hasBefore && before) observer.observe(before)
    if (hasMore && after) observer.observe(after)
    return () => observer.disconnect()
  }, [viewKey, hasBefore, hasMore, loading, error, range.start, range.end])

  const remember = (ids: number[]): void => {
    if (!bookmarkKey) return
    try { localStorage.setItem(bookmarkKey, JSON.stringify({ filters, ids } satisfies CatalogBookmark)) } catch {}
  }
  const resume = (): void => {
    if (!bookmarkKey || loading === 'resume') return
    const latest = readBookmark(bookmarkKey)
    if (latest) load({ kind: 'resume', bookmark: latest })
    else setOffer(null)
  }
  const changeQuery = (next: string): void => {
    if (loading === 'resume') {
      controller.current?.abort()
      controller.current = null
      setLoading(null)
    }
    if (next) lastQueries.set(owner, next)
    else lastQueries.delete(owner)
    setQuery(next)
  }

  // 页头的扇面跟着当前列表走：筛了年份 / 搜了名字，叠着的就是那几部
  const fan = useMemo(() => {
    const covers: CatalogItem[] = []
    for (const item of items) {
      if (item.cover) covers.push(item)
      if (covers.length === 3) break
    }
    return covers
  }, [items])

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
            <div className="searchbar searchbar-clearable">
              <Ic name="search" cls="ic" />
              <input
                spellCheck={false}
                autoComplete="off"
                value={query}
                onChange={(e) => changeQuery(e.target.value)}
                placeholder="搜番名、日文名或别名…"
                aria-label="搜索全部番剧"
              />
              {query && <button type="button" className="search-clear" onClick={() => changeQuery('')} aria-label="清空搜索"><Ic name="x" cls="ic ic-sm" /></button>}
            </div>
            <div className="catalog-year">
              <Select options={YEAR_OPTIONS} value={String(year)} onChange={(id) => updateFilters({ year: Number(id) })} placeholder="全部年份" />
            </div>
            <div className="seg" role="group" aria-label="排序">
              <button type="button" className={sort === 'score' ? 'on' : ''} aria-pressed={sort === 'score'} onClick={() => updateFilters({ sort: 'score' })}>评分</button>
              <button type="button" className={sort === 'date' ? 'on' : ''} aria-pressed={sort === 'date'} onClick={() => updateFilters({ sort: 'date' })}>最新</button>
            </div>
          </div>
          {bookmark && <div className="catalog-resume">
            <button type="button" className="btn" disabled={loading === 'resume'} aria-busy={loading === 'resume'} onClick={resume}>继续上次浏览</button>
            <span className="catalog-resume-note" role="status">{resumeNote}</span>
          </div>}
        </div>
        {fan.length > 0 && (
          <div className="catalog-fan" aria-hidden="true">
            {fan.map((item) => <img key={item.bgmId} src={coverUrl(item.cover, item.bgmId)} alt="" draggable={false} />)}
          </div>
        )}
      </header>

      {planningReady && <div className="catalog-planning" role="group" aria-label="篇幅与播出状态">
        <div className="catalog-length">
          <Select options={[{ id: '0', text: '不限集数' }, { id: '13', text: '13 集以内' }, { id: '26', text: '26 集以内' }, { id: '52', text: '52 集以内' }]} value={String(maxEps)} onChange={id => updateFilters({ maxEps: Number(id) })} placeholder="不限集数" />
        </div>
        <button type="button" className={`chip${finished ? ' on' : ''}`} aria-pressed={finished} onClick={() => updateFilters({ finished: !finished })}>已播完</button>
        {(maxEps > 0 || finished) && <button type="button" className="btn btn-ghost small" onClick={() => updateFilters({ maxEps: 0, finished: false })}>清空篇幅与状态</button>}
      </div>}

      <CatalogDiscovery key={range.revision} value={discovery} genres={genres} admin={admin} onApply={updateFilters} onGenresSaved={() => { viewCache.clear(); load({ kind: 'first' }) }} />
      {sourceWatch.modals}
      {watchTarget && <WatchSourceDialog
        ep={watchEp(watchTarget)}
        bound={Object.fromEntries(SOURCES.map(source => [source.id, sourceWatch.bindings[source.id][watchTarget.bgmId]]))}
        onClose={() => setWatchChoice(null)}
        onPick={(source, mode, rebind) => posterWatch.onContinue(watchTarget, source, mode, rebind)}
      />}
      {relatedId !== null && <RelatedAnimeDialog key={relatedId} id={relatedId} tracks={track.tracksById}
        onAdd={item => { if (!track.tracked.has(item.bgmId)) track.toggle(asCalendarItem(item), 0, 'plan') }} onClose={() => setRelatedId(null)} />}
      {editing && (
        <CatalogEditDialog
          item={editing}
          onSaved={(next) => {
            // 只有手改过的标签是完整列表（索引标签回给前端时截了前 6 个），据此判断；改了标签可能不再符合题材条件：原地拿掉这一张，不重读目录，免得丢滚动位置
            const stillMatches = !next.edited?.tags || discovery.include.every((t) => next.tags.includes(t)) && !discovery.exclude.some((t) => next.tags.includes(t))
            setRange(prev => ({
              ...prev,
              end: prev.end - (!stillMatches && prev.items.some(i => i.bgmId === next.bgmId) ? 1 : 0),
              items: stillMatches ? prev.items.map(i => i.bgmId === next.bgmId ? next : i) : prev.items.filter(i => i.bgmId !== next.bgmId),
            }))
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

      {hasBefore && <div ref={beforeRef} className="catalog-before">
        {loading === 'before' ? <Spinner size={24} /> : <button type="button" className="btn btn-ghost" onClick={() => load({ kind: 'before' })}>加载前面的番剧</button>}
      </div>}

      {!ready ? (
        <div className="page-state"><p className="faint small">番剧目录还没整理好，晚点再来</p></div>
      ) : items.length === 0 && loading ? (
        <div className="page-state"><Spinner size={36} /><p className="faint small">纱雾正在翻目录…</p></div>
      ) : items.length === 0 && !error ? (
        <div className="page-state"><p className="faint small">{maxEps > 0 || finished ? '没有符合这些条件的番，试着放宽集数或取消已播完' : discovery.include.length || discovery.exclude.length ? '没有符合这些条件的番，试着减少题材或清空题材筛选' : q ? (year > 0 ? `没有找到 ${year} 年的「${q}」` : `没有找到「${q}」，换个名字试试`) : '这一年没有收录的番'}</p></div>
      ) : (
        <CatalogGrid key={`${range.key}:${range.revision}`} items={items} stale={stale} restoreId={range.restoreId}
          atStart={range.start === 0} onBrowse={bookmarkKey && !stale && range.key === viewKey && !query.trim() && !q && loading !== 'resume' ? remember : undefined}
          render={item => (
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
            onRelated={() => setRelatedId(item.bgmId)}
            coverExtra={admin && (
              <button type="button" className="catalog-edit-btn" onClick={() => setEditing(item)} aria-label="编辑卡片" title="编辑卡片">
                <Ic name="pencil" cls="ic ic-sm" />
              </button>
            )}
          />
        )} />
      )}

      {hasMore && (
        <div ref={moreRef} className="trk-more">
          {loading === 'after' ? <Spinner size={24} /> : (
            <button type="button" className="btn btn-ghost" onClick={() => load({ kind: 'after' })}>加载更多</button>
          )}
        </div>
      )}
    </div>
  )
}
