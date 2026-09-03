import { useEffect, useRef, useState } from 'react'
import { searchAnime, searchAnimeOnline, type AnimeHit, type AnimeSearchMode } from '../api'
import { Ic, Spinner } from '../SketchIcon'

// ── 加番搜索弹窗 ───────────────────────────────────────────────────────────────
// 默认搜索由服务端翻离线索引 → 已加番共享补充；点「在线搜 Bangumi」才访问在线结果。
// 防抖 300ms；点「贴进手帐」即时加、弹窗不关（可连着加多部）；已在追的显示已存在、不可重复加。
// 「自己记一条」用负数 bgmId 留下待回填的手动条目；从卡片进入时复用这扇窗选 BGM 并回填。
// 索引超过这个天数没更新就提示。一周一档 + 3 天容错：正常同步永远碰不到，挂了才会露头
const STALE_AFTER_DAYS = 10

const ADD_COPY = {
  subtitle: '哼，先把想看的贴好。找得到 BGM 就认领，找不到也能先留一张手帐。',
  backfillSubtitle: '先把这张手帐和 BGM 对上，进度、标签和封面都会留下。',
  searchPlaceholder: '想找哪部番？番名、日文原名或罗马音都可以……',
  loadingLocal: '纱雾正在翻目录……',
  loadingOnline: '纱雾去 Bangumi 门口问问……',
  idle: '把番名写进来，纱雾帮你翻目录……',
  noIndex: '番剧目录还没整理好……晚点再来，别催。',
  stale: (days: number) => `索引已经 ${days} 天没更新……纱雾先照现有的找，新番可能还没翻到。`,
  noResults: (query: string) => `没有找到「${query}」……换个名字再试试？`,
  online: '这是 Bangumi 刚翻回来的结果，纱雾先贴给你看……',
  onlineNoResults: (query: string) => `Bangumi 也没找到「${query}」……换个名字再试试？`,
  onlineAction: '在线搜 Bangumi',
  localAction: '翻离线目录',
  network: 'Bangumi 的回信没接上，纱雾先放一边……',
  searchTab: '找 BGM 条目',
  customTab: '自己记一条',
  customTitle: 'BGM 还没来？先写在这里',
  customSubtitle: '新番刚冒头也没关系，先留住这份心情，等 BGM 收录后再回填。',
  customPlaceholder: '番名写在这里……',
  customSubmit: '贴进手帐',
  customEmpty: '先写个标题嘛……',
  backfillAction: '回填',
  backfillBusy: '回填中…',
  tracked: '已在追番',
  add: '加入',
} as const

type AddTab = 'search' | 'custom'

export interface BackfillTarget {
  customBgmId: number
  title: string
}

export function AddSearchModal({
  trackedIds,
  onAdd,
  onAddCustom,
  backfill,
  onBackfill,
  initialQuery,
  onClose,
}: {
  trackedIds: Set<number>
  onAdd: (hit: AnimeHit) => void
  onAddCustom: (title: string) => Promise<void>
  backfill?: BackfillTarget
  onBackfill?: (customBgmId: number, hit: AnimeHit) => Promise<void>
  initialQuery?: string
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [results, setResults] = useState<AnimeHit[]>([])
  const [ready, setReady] = useState(true)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<AnimeSearchMode>('local')
  const [tab, setTab] = useState<AddTab>('search')
  const [customTitle, setCustomTitle] = useState(initialQuery ?? '')
  const [customBusy, setCustomBusy] = useState(false)
  const [customError, setCustomError] = useState('')
  const [backfillBusyId, setBackfillBusyId] = useState<number | null>(null)
  const [backfillError, setBackfillError] = useState('')
  // 每次改词 / 切换来源都递增，晚到的响应只落在发起它的那一轮，保持新结果优先。
  const requestIdRef = useRef(0)
  // 来源只描述结果从哪来；模式描述用户当前正在看哪一路。
  const [source, setSource] = useState<'local' | 'learned' | 'online' | undefined>()
  const [onlineError, setOnlineError] = useState('')
  const [builtAt, setBuiltAt] = useState(0) // 索引生成时间，用来提示「同步是不是挂了」

  // 开弹窗就先问一次索引状态（q 为空 = 只回统计、不搜也不联网）。
  // 不等用户输入才知道 —— 「索引没生成」和「同步挂了」都该进门就看见。
  useEffect(() => {
    searchAnime('')
      .then((r) => {
        setReady(r.ready)
        setBuiltAt(r.builtAt ?? 0)
      })
      .catch(() => {
        /* 状态查不到就不提示，别让它盖住正常搜索 */
      })
  }, [])
  const [added, setAdded] = useState<Set<number>>(new Set()) // 本次弹窗点过的，即时变「已追」

  const finishSearch = (id: number, r: Awaited<ReturnType<typeof searchAnime>>): void => {
    if (id !== requestIdRef.current) return
    setReady(r.ready)
    setResults(r.data)
    setSource(r.source)
    setOnlineError(r.onlineError ?? '')
    if (r.builtAt) setBuiltAt(r.builtAt)
    setLoading(false)
  }

  const runSearch = (raw: string, nextMode: AnimeSearchMode): void => {
    const q = raw.trim()
    if (!q) return
    const id = ++requestIdRef.current
    setMode(nextMode)
    setResults([])
    setSource(undefined)
    setOnlineError('')
    setBackfillError('')
    setLoading(true)
    const request = nextMode === 'online' ? searchAnimeOnline(q) : searchAnime(q)
    void request
      .then((r) => finishSearch(id, r))
      .catch(() => {
        if (id !== requestIdRef.current) return
        setResults([])
        setOnlineError(nextMode === 'online' ? ADD_COPY.network : '')
        setLoading(false)
      })
  }

  const openCustom = (): void => {
    setCustomError('')
    setCustomTitle(query.trim())
    setTab('custom')
    requestIdRef.current++
    setResults([])
    setSource(undefined)
    setOnlineError('')
    setLoading(false)
  }

  const openSearch = (): void => {
    setTab('search')
    setCustomError('')
    setMode('local')
    setOnlineError('')
    setBackfillError('')
    setLoading(!!query.trim())
  }

  const submitCustom = (): void => {
    const title = customTitle.trim()
    if (!title) {
      setCustomError(ADD_COPY.customEmpty)
      return
    }
    setCustomBusy(true)
    setCustomError('')
    void onAddCustom(title)
      .then(() => {
        setCustomTitle('')
        setQuery('')
        setTab('search')
      })
      .catch((error: unknown) => {
        setCustomError(error instanceof Error ? error.message : '这条手帐没贴好……')
      })
      .finally(() => setCustomBusy(false))
  }

  const backfillHit = (hit: AnimeHit): void => {
    if (!backfill || !onBackfill || backfillBusyId != null) return
    setBackfillError('')
    setBackfillBusyId(hit.bgmId)
    void onBackfill(backfill.customBgmId, hit)
      .catch((error: unknown) => {
        setBackfillError(error instanceof Error ? error.message : '回填没有完成……')
      })
      .finally(() => setBackfillBusyId(null))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 默认搜索只翻离线目录；停手 300ms 再打接口，别每个键都发。
  useEffect(() => {
    if (tab !== 'search') return
    const q = query.trim()
    if (!q) {
      requestIdRef.current++
      setResults([])
      setSource(undefined)
      setOnlineError('')
      setLoading(false)
      return
    }
    const timer = setTimeout(() => runSearch(q, 'local'), 300)
    return () => clearTimeout(timer)
  }, [query, tab])

  const onQueryChange = (value: string): void => {
    // 换词即回到默认离线路；先作废上一轮在线请求，避免它在防抖期间回写旧词结果。
    requestIdRef.current++
    setQuery(value)
    setMode('local')
    setResults([])
    setSource(undefined)
    setOnlineError('')
    setBackfillError('')
    setLoading(!!value.trim())
  }

  const add = (hit: AnimeHit): void => {
    setAdded((prev) => new Set(prev).add(hit.bgmId))
    onAdd(hit)
  }

  const q = query.trim()
  const staleDays = builtAt ? Math.floor((Date.now() - builtAt) / 86400000) : 0

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={backfill ? '回填 BGM' : '加番'} className="dlg dlg-add">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">{backfill ? '回填 BGM' : '加番'}</h3>
        <p className="dlg-sub">{backfill ? ADD_COPY.backfillSubtitle : ADD_COPY.subtitle}</p>

        <div className={`add-mode-tabs${backfill ? ' is-backfill' : ''}`} role="tablist" aria-label="选择加番方式">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'search'}
            aria-controls="addSearchPanel"
            className={`add-mode-tab${tab === 'search' ? ' on' : ''}`}
            onClick={openSearch}
          >
            <Ic name="search" cls="ic ic-sm" />
            {ADD_COPY.searchTab}
          </button>
          {!backfill && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'custom'}
              aria-controls="customAddPanel"
              className={`add-mode-tab${tab === 'custom' ? ' on' : ''}`}
              title="BGM 还没收录时，先按标题记一条"
              onClick={openCustom}
            >
              <Ic name="plus" cls="ic ic-sm" />
              {ADD_COPY.customTab}
            </button>
          )}
        </div>

        {tab === 'search' && (
          <div className="add-search-panel-head">
            <div className="add-search-row mb16">
              <div className="searchbar" style={{ maxWidth: 'none' }}>
                <Ic name="search" cls="ic" />
                <input
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  value={query}
                  onChange={(e) => onQueryChange(e.target.value)}
                  aria-label="搜索要贴进手帐的番剧"
                  placeholder={ADD_COPY.searchPlaceholder}
                />
              </div>
              {q && (
                <button
                  type="button"
                  className={`btn btn-sm ${mode === 'online' ? 'btn-ghost' : 'btn-primary'} add-online-btn`}
                  disabled={loading}
                  title={mode === 'online' ? '回到离线目录' : '想找刚更新的条目，去 Bangumi 看看'}
                  onClick={() => runSearch(q, mode === 'online' ? 'local' : 'online')}
                >
                  <Ic name={mode === 'online' ? 'back' : 'refresh'} cls="ic ic-sm" />
                  {mode === 'online' ? ADD_COPY.localAction : ADD_COPY.onlineAction}
                </button>
              )}
            </div>
          </div>
        )}

        {/* 索引太旧 = 服务器上每周的同步任务多半挂了。不提示的话，用户只会觉得「新番搜不到」，
            跟正常的一周滞后长得一模一样，永远发现不了。10 天 = 一周档期 + 3 天容错。 */}
        {tab === 'search' && mode === 'local' && ready && staleDays >= STALE_AFTER_DAYS && (
          <p className="form-note err mb16">
            {ADD_COPY.stale(staleDays)}
          </p>
        )}

        {/* 定高结果区：弹窗尺寸不随「空搜索 / 搜到 8 条 / 没搜到」跳动 —— 输入时容器
            忽大忽小，视线要跟着窗口重新找位置 */}
        <div
          className="add-pane"
          id={tab === 'search' ? 'addSearchPanel' : 'customAddPanel'}
          role="tabpanel"
          aria-label={tab === 'search' ? ADD_COPY.searchTab : ADD_COPY.customTab}
        >
          {tab === 'custom' && !backfill ? (
            <div className="custom-add-pane">
              <div className="custom-add-seal" aria-hidden="true">先留一页</div>
              <h4>{ADD_COPY.customTitle}</h4>
              <p className="faint small">{ADD_COPY.customSubtitle}</p>
              <label className="custom-add-field">
                <span>番名</span>
                <input
                  autoFocus
                  value={customTitle}
                  onChange={(e) => {
                    setCustomTitle(e.target.value)
                    if (customError) setCustomError('')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitCustom()
                  }}
                  placeholder={ADD_COPY.customPlaceholder}
                  aria-label="自定义番名"
                  spellCheck={false}
                  maxLength={200}
                  disabled={customBusy}
                />
              </label>
              {customError && <p className="form-note err">{customError}</p>}
              <button type="button" className="btn btn-primary custom-add-submit" onClick={submitCustom} disabled={customBusy}>
                {customBusy ? <Spinner size={14} /> : <Ic name="plus" cls="ic ic-sm" />}
                {ADD_COPY.customSubmit}
              </button>
            </div>
          ) : loading ? (
            <div className="page-state">
              <Spinner size={26} />
              <p className="faint small">{mode === 'online' ? ADD_COPY.loadingOnline : ADD_COPY.loadingLocal}</p>
            </div>
          ) : !q ? (
            <p className="faint small">
              {mode === 'local' && !ready ? ADD_COPY.noIndex : ADD_COPY.idle}
            </p>
          ) : mode === 'local' && !ready ? (
            <p className="faint small">
              {ADD_COPY.noIndex}
            </p>
          ) : results.length === 0 ? (
            <p className="faint small">
              {mode === 'online' ? ADD_COPY.onlineNoResults(q) : ADD_COPY.noResults(q)}
              {mode === 'local' && (
                <>
                  <br />
                  <button type="button" className="link add-online-link" onClick={() => runSearch(q, 'online')}>
                    {ADD_COPY.onlineAction}？
                  </button>
                </>
              )}
              {/* 在线请求失败时保留具体原因，用户知道是等一会儿还是换关键词。 */}
              {onlineError && (
                <>
                  <br />
                  <span style={{ color: 'var(--ink-sub)' }}>{onlineError}</span>
                </>
              )}
            </p>
          ) : (
            /* 定高列表（原型稿 #addList）：容器不随结果条数变高变矮，多出来的走竖向滚动 */
            <div id="addList">
              {backfillError && <p className="form-note err add-backfill-error">{backfillError}</p>}
              {source === 'online' && (
                <p className="faint small add-source-note">{ADD_COPY.online}</p>
              )}
              {results.map((h) => {
                const tracked = trackedIds.has(h.bgmId) || added.has(h.bgmId)
                const year = h.date && h.date.length >= 4 ? h.date.slice(0, 4) : ''
                // 主标题要一眼可读：中文译名优先；副信息（原名 / 年份 / 评分）弱化成第二行
                const mainTitle = h.nameCn || h.name
                const sub = [h.nameCn && h.name !== h.nameCn ? h.name : '', year ? `${year}年` : '', h.score > 0 ? `★ ${h.score.toFixed(1)}` : '']
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <div key={h.bgmId} className="sugg-item">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mainTitle}>
                        {mainTitle}
                      </div>
                      {sub && (
                        <div className="faint small" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sub}>
                          {sub}
                        </div>
                      )}
                    </div>
                    {tracked ? (
                      <span className="tagx mine" style={{ flex: 'none' }}>
                        {ADD_COPY.tracked}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        style={{ flex: 'none' }}
                        disabled={backfillBusyId != null}
                        onClick={() => (backfill ? backfillHit(h) : add(h))}
                      >
                        {backfill && backfillBusyId === h.bgmId ? <Spinner size={14} /> : <Ic name="plus" cls="ic ic-sm" />}
                        {backfill ? (backfillBusyId === h.bgmId ? ADD_COPY.backfillBusy : ADD_COPY.backfillAction) : ADD_COPY.add}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
