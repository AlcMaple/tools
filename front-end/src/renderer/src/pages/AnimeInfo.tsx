import { useState, useEffect, useRef } from 'react'
import TopBar from '../components/TopBar'
import type { BgmSearchResult, BgmDetail } from '../types/bgm'
import type { XifanSearchResult, XifanWatchInfo } from '../types/xifan'
import { downloadStore } from '../stores/downloadStore'

// ── 工具函数 ──────────────────────────────────────────────────
function extractSubjectId(link: string): number | null {
  const m = link.match(/\/subject\/(\d+)/)
  return m ? parseInt(m[1]) : null
}

// ── Archive 缓存（与 SearchDownload 共享同一套 key）────────────

// ArchiveFlow 自己的缓存（XifanSearchResult 格式）
const ARCHIVE_CACHE_KEY = 'archive_search_cache_xifan'

async function getSearchCache(keyword: string): Promise<XifanSearchResult[] | null> {
  // 先查 ArchiveFlow 自己的缓存
  try {
    const c = (await window.systemApi.cacheGet(ARCHIVE_CACHE_KEY)) as Record<string, XifanSearchResult[]> | null
    console.log('[ArchiveFlow] own cache:', c ? Object.keys(c) : null)
    if (c?.[keyword]) {
      console.log('[ArchiveFlow] own cache HIT for', keyword)
      return c[keyword]
    }
  } catch (e) { console.warn('[ArchiveFlow] own cache error', e) }

  // 回落到 SearchDownload 的缓存，SearchCard.key → watch_url
  try {
    const sd = (await window.systemApi.cacheGet('search_cache_xifan')) as Record<string, any[]> | null
    console.log('[ArchiveFlow] SD cache keys:', sd ? Object.keys(sd) : null, '| looking for:', JSON.stringify(keyword))
    if (sd?.[keyword]) {
      const mapped = sd[keyword]
        .map((c: any): XifanSearchResult => ({
          title: c.title ?? '',
          cover: c.cover ?? '',
          year: c.year ?? '',
          area: c.tag ?? '',
          episode: c.count ?? '',
          watch_url: c.key ?? '',       // SearchCard 用 key 存 watch_url
          detail_url: '',
        }))
      console.log('[ArchiveFlow] SD cache HIT:', mapped.length, 'items, with watch_url:', mapped.filter(r => r.watch_url).length)
      const withUrl = mapped.filter(r => r.watch_url)
      if (withUrl.length > 0) return withUrl
      // 有结果但全都没有 watch_url：仍然返回所有结果让用户选
      if (mapped.length > 0) return mapped
    }
  } catch (e) { console.warn('[ArchiveFlow] SD cache error', e) }

  return null
}

async function setSearchCache(keyword: string, cards: XifanSearchResult[]): Promise<void> {
  try {
    const c = ((await window.systemApi.cacheGet(ARCHIVE_CACHE_KEY)) as Record<string, XifanSearchResult[]>) || {}
    c[keyword] = cards
    await window.systemApi.cacheSet(ARCHIVE_CACHE_KEY, c)
  } catch { /* noop */ }
}

function getWatchCache(url: string): XifanWatchInfo | null {
  try {
    return (JSON.parse(localStorage.getItem('xifan_watch_cache_v3') || '{}') as Record<string, XifanWatchInfo>)[url] ?? null
  } catch { return null }
}

function setWatchCache(url: string, info: XifanWatchInfo): void {
  try {
    const c = JSON.parse(localStorage.getItem('xifan_watch_cache_v3') || '{}') as Record<string, XifanWatchInfo>
    c[url] = info
    localStorage.setItem('xifan_watch_cache_v3', JSON.stringify(c))
  } catch { /* noop */ }
}

function getSavePath(): string | undefined {
  try { return JSON.parse(localStorage.getItem('xifan_settings') || '{}').downloadPath || undefined } catch { return undefined }
}

// ── XifanConfigModal ──────────────────────────────────────────

function XifanConfigModal({ card, watchInfo, onClose, onStart }: {
  card: XifanSearchResult
  watchInfo: XifanWatchInfo
  onClose: () => void
  onStart: (templates: string[], startEp: number, endEp: number) => void
}): JSX.Element {
  const validSources = watchInfo.sources.filter(s => s.template)
  const [selectedIdx, setSelectedIdx] = useState(validSources[0]?.idx ?? 1)
  const [startStr, setStartStr] = useState('1')
  const [endStr, setEndStr] = useState(String(watchInfo.total))

  const clampStart = (s: string): number => Math.max(1, Math.min(watchInfo.total, parseInt(s, 10) || 1))
  const clampEnd = (s: string, start: number): number => Math.max(start, Math.min(watchInfo.total, parseInt(s, 10) || watchInfo.total))

  const handleStart = (): void => {
    const selected = validSources.find(s => s.idx === selectedIdx)
    if (!selected?.template) return
    const ordered = [
      selected.template,
      ...validSources.filter(s => s.idx !== selectedIdx).map(s => s.template!),
    ]
    onStart(ordered, clampStart(startStr), clampEnd(endStr, clampStart(startStr)))
  }

  return (
    <div className="relative bg-surface-container w-full max-w-lg rounded-2xl border border-outline-variant/20 overflow-hidden shadow-2xl">
      <div className="p-6 border-b border-outline-variant/20 bg-surface-container-low flex justify-between items-center">
        <div>
          <h3 className="font-headline font-black text-lg text-on-surface tracking-tight">{watchInfo.title || card.title}</h3>
          <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">{watchInfo.total} Episodes · Xifan</p>
        </div>
        <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface transition-colors">
          <span className="material-symbols-outlined leading-none">close</span>
        </button>
      </div>

      <div className="p-6 space-y-6">
        {validSources.length > 0 ? (
          <div>
            <p className="font-label text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-3">Download Source</p>
            <div className="space-y-2">
              {validSources.map(src => (
                <label key={src.idx} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${selectedIdx === src.idx ? 'border-primary/40 bg-primary/5' : 'border-outline-variant/20 hover:bg-surface-container-high'}`}>
                  <input type="radio" name="archive_source" value={src.idx} checked={selectedIdx === src.idx} onChange={() => setSelectedIdx(src.idx)} className="accent-primary" />
                  <span className="font-label text-sm text-on-surface">{src.name.replace(/[\uE000-\uF8FF]/g, '').trim()}</span>
                  <span className="ml-auto font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest">{watchInfo.total} Episodes</span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-lg bg-error/10 border border-error/20">
            <p className="font-label text-xs text-error">No valid download sources found.</p>
          </div>
        )}

        <div>
          <p className="font-label text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-3">Episode Range</p>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest block mb-1.5">From</label>
              <input type="number" min={1} max={watchInfo.total} value={startStr} onChange={e => setStartStr(e.target.value)} onBlur={() => setStartStr(String(clampStart(startStr)))} className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg px-3 py-2.5 text-sm font-label text-on-surface outline-none focus:border-primary/40 transition-colors" />
            </div>
            <span className="text-on-surface-variant/30 mt-5">—</span>
            <div className="flex-1">
              <label className="font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest block mb-1.5">To</label>
              <input type="number" min={1} max={watchInfo.total} value={endStr} onChange={e => setEndStr(e.target.value)} onBlur={() => setEndStr(String(clampEnd(endStr, clampStart(startStr))))} className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg px-3 py-2.5 text-sm font-label text-on-surface outline-none focus:border-primary/40 transition-colors" />
            </div>
            <div className="mt-5">
              <span className="font-label text-[10px] text-on-surface-variant/30">/ {watchInfo.total}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 font-label text-sm text-on-surface-variant hover:bg-surface-container-high transition-colors">
            Cancel
          </button>
          <button onClick={handleStart} disabled={validSources.length === 0} className="flex-1 py-3 rounded-xl bg-primary text-on-primary font-label text-sm font-black tracking-widest hover:brightness-110 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-base leading-none">bolt</span>
            START DOWNLOAD
          </button>
        </div>
      </div>
    </div>
  )
}

// ── ArchiveFlow ───────────────────────────────────────────────
// 独立状态机，叠加在页面上处理完整的搜索→验证→配置→下载流程

type ArchiveFlowState =
  | { status: 'searching' }
  | { status: 'captcha'; imageB64: string; error?: string }
  | { status: 'verifying' }
  | { status: 'results'; cards: XifanSearchResult[] }
  | { status: 'loadingWatch'; card: XifanSearchResult }
  | { status: 'configuring'; card: XifanSearchResult; watchInfo: XifanWatchInfo }
  | { status: 'queued' }
  | { status: 'error'; message: string }

function ArchiveFlow({ keyword: initialKeyword, onClose }: { keyword: string; onClose: () => void }): JSX.Element {
  const [state, setState] = useState<ArchiveFlowState>({ status: 'searching' })
  const [captchaInput, setCaptchaInput] = useState('')
  const [searchKeyword, setSearchKeyword] = useState(initialKeyword)
  const activeKeyword = useRef(initialKeyword)

  useEffect(() => { void doSearch(initialKeyword) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function doSearch(kw: string, skipCache = false): Promise<void> {
    activeKeyword.current = kw
    setSearchKeyword(kw)
    setState({ status: 'searching' })

    if (!skipCache) {
      const cached = await getSearchCache(kw)
      if (cached && cached.length > 0) { handleResults(kw, cached); return }
    }

    console.log('[ArchiveFlow] doing fresh Xifan search for:', kw)
    try {
      const result = await window.xifanApi.search(kw)
      console.log('[ArchiveFlow] fresh search result:', Array.isArray(result) ? `array[${result.length}]` : result)
      if (!Array.isArray(result) && result.needs_captcha) {
        const { image_b64 } = await window.xifanApi.getCaptcha()
        setCaptchaInput('')
        setState({ status: 'captcha', imageB64: image_b64 })
      } else if (Array.isArray(result)) {
        if (result.length > 0) void setSearchCache(kw, result)
        handleResults(kw, result)
      } else {
        setState({ status: 'error', message: `Xifan 返回了意外的响应` })
      }
    } catch (err) {
      setState({ status: 'error', message: `Search failed: ${String(err)}` })
    }
  }

  function handleResults(kw: string, cards: XifanSearchResult[]): void {
    if (cards.length === 0) {
      setState({ status: 'error', message: `Xifan 未找到与"${kw}"相关的结果` })
      return
    }
    if (cards.length === 1) { void loadWatch(cards[0]); return }
    setState({ status: 'results', cards })
  }

  async function loadWatch(card: XifanSearchResult): Promise<void> {
    setState({ status: 'loadingWatch', card })
    try {
      const cached = getWatchCache(card.watch_url)
      if (cached) { setState({ status: 'configuring', card, watchInfo: cached }); return }
      const watchInfo = await window.xifanApi.getWatch(card.watch_url)
      setWatchCache(card.watch_url, watchInfo)
      setState({ status: 'configuring', card, watchInfo })
    } catch (err) {
      setState({ status: 'error', message: `Failed to load sources: ${String(err)}` })
    }
  }

  async function handleVerify(): Promise<void> {
    if (state.status !== 'captcha') return
    setState({ status: 'verifying' })
    try {
      const { success } = await window.xifanApi.verifyCaptcha(captchaInput.trim())
      if (success) {
        await doSearch(activeKeyword.current, true)
      } else {
        const { image_b64 } = await window.xifanApi.getCaptcha()
        setCaptchaInput('')
        setState({ status: 'captcha', imageB64: image_b64, error: 'Wrong code, try again.' })
      }
    } catch { onClose() }
  }

  async function handleRefreshCaptcha(): Promise<void> {
    try {
      const { image_b64 } = await window.xifanApi.getCaptcha()
      setCaptchaInput('')
      setState({ status: 'captcha', imageB64: image_b64 })
    } catch { /* noop */ }
  }

  async function handleStartDownload(templates: string[], startEp: number, endEp: number): Promise<void> {
    if (state.status !== 'configuring') return
    const { card, watchInfo } = state
    const title = watchInfo.title || card.title
    const savePath = getSavePath()
    try {
      const { taskId, pid } = await window.xifanApi.startDownload(title, templates, startEp, endEp, savePath)
      const epStatus: Record<number, 'pending'> = {}
      for (let ep = startEp; ep <= endEp; ep++) epStatus[ep] = 'pending'
      downloadStore.addTask({
        id: taskId,
        source: 'xifan',
        title,
        cover: card.cover,
        startEp,
        endEp,
        templates,
        savePath,
        status: 'running',
        epStatus,
        epProgress: {},
        startedAt: Date.now(),
        pid,
      })
      setState({ status: 'queued' })
      setTimeout(onClose, 2000)
    } catch (err) { alert(`Download error: ${err}`) }
  }

  const isLoading = state.status === 'searching' || state.status === 'verifying' || state.status === 'loadingWatch'

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm">
      {/* 点击背景关闭（加载中仍可关闭） */}
      <div className="absolute inset-0" onClick={onClose} />

      {/* 加载中 */}
      {isLoading && (
        <div className="relative bg-surface-container w-full max-w-sm rounded-2xl border border-outline-variant/20 p-12 flex flex-col items-center gap-6 shadow-2xl">
          <div className="w-10 h-10 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          <p className="font-label text-xs text-on-surface-variant/60 uppercase tracking-widest">
            {state.status === 'searching' ? 'Searching Xifan...' : state.status === 'verifying' ? 'Verifying...' : 'Loading sources...'}
          </p>
        </div>
      )}

      {/* 验证码 */}
      {state.status === 'captcha' && (
        <div className="relative bg-surface-container w-full max-w-md rounded-2xl border border-outline-variant/20 overflow-hidden shadow-2xl">
          <div className="p-6 border-b border-outline-variant/20 bg-surface-container-low flex justify-between items-center">
            <div>
              <h3 className="font-headline font-black text-lg text-on-surface">Verification Required</h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">Xifan requires captcha to search</p>
            </div>
            <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface transition-colors">
              <span className="material-symbols-outlined leading-none">close</span>
            </button>
          </div>
          <div className="p-6 space-y-4">
            <div className="relative">
              <img src={`data:image/gif;base64,${state.imageB64}`} alt="captcha" className="w-full rounded-lg border border-outline-variant/20" />
              <button
                onClick={() => void handleRefreshCaptcha()}
                className="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface-container-high/80 backdrop-blur-sm flex items-center justify-center text-on-surface-variant hover:text-primary transition-colors"
                title="Refresh captcha"
              >
                <span className="material-symbols-outlined text-base leading-none">refresh</span>
              </button>
            </div>
            <input
              type="text"
              value={captchaInput}
              onChange={e => setCaptchaInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && captchaInput.trim()) void handleVerify() }}
              placeholder="Enter code above"
              autoFocus
              className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-xl px-4 py-3 font-label text-sm text-on-surface outline-none focus:border-primary/40 transition-colors placeholder:text-on-surface-variant/30"
            />
            {state.error && (
              <p className="font-label text-xs text-error">{state.error}</p>
            )}
          </div>
          <div className="p-6 pt-0 flex gap-3">
            <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 font-label text-sm text-on-surface-variant hover:bg-surface-container-high transition-colors">
              Cancel
            </button>
            <button
              onClick={() => void handleVerify()}
              disabled={!captchaInput.trim()}
              className="flex-[2] py-3 rounded-xl bg-primary text-on-primary font-label text-sm font-bold tracking-widest hover:brightness-110 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Verify
            </button>
          </div>
        </div>
      )}

      {/* 搜索结果选择 */}
      {state.status === 'results' && (
        <div className="relative bg-surface-container w-full max-w-lg rounded-2xl border border-outline-variant/20 overflow-hidden shadow-2xl flex flex-col max-h-[70vh]">
          <div className="p-6 border-b border-outline-variant/20 bg-surface-container-low flex justify-between items-center shrink-0">
            <div>
              <h3 className="font-headline font-black text-lg text-on-surface">Select from Xifan</h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">
                {state.cards.length} results for "{activeKeyword.current}"
              </p>
            </div>
            <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface transition-colors">
              <span className="material-symbols-outlined leading-none">close</span>
            </button>
          </div>
          <div className="overflow-y-auto flex-1 p-4 space-y-2">
            {state.cards.map(card => (
              <button
                key={card.watch_url}
                onClick={() => void loadWatch(card)}
                className="w-full flex items-center justify-between bg-surface hover:bg-surface-container-high border border-outline-variant/10 hover:border-primary/20 rounded-xl px-5 py-4 text-left transition-all group"
              >
                <div className="min-w-0">
                  <p className="font-bold text-on-surface text-sm group-hover:text-primary transition-colors truncate">{card.title}</p>
                  <p className="font-label text-[10px] text-on-surface-variant/50 mt-0.5 uppercase tracking-widest">
                    {[card.year, card.episode, card.area].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/20 group-hover:text-primary/50 transition-colors text-lg shrink-0 ml-4">arrow_forward</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 下载配置 */}
      {state.status === 'configuring' && (
        <XifanConfigModal
          card={state.card}
          watchInfo={state.watchInfo}
          onClose={onClose}
          onStart={(templates, startEp, endEp) => void handleStartDownload(templates, startEp, endEp)}
        />
      )}

      {/* 错误提示 */}
      {state.status === 'error' && (
        <div className="relative bg-surface-container w-full max-w-sm rounded-2xl border border-outline-variant/20 p-10 flex flex-col items-center gap-6 shadow-2xl">
          <div className="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-error text-4xl leading-none">error_outline</span>
          </div>
          <div className="text-center">
            <p className="font-label text-xs text-error uppercase tracking-[0.2em] mb-2">Failed</p>
            <p className="font-body text-sm text-on-surface-variant leading-relaxed">{state.message}</p>
          </div>
          <div className="w-full">
            <input
              type="text"
              value={searchKeyword}
              onChange={e => setSearchKeyword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && searchKeyword.trim()) void doSearch(searchKeyword.trim(), true) }}
              className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-xl px-4 py-2.5 font-label text-sm text-on-surface outline-none focus:border-primary/40 transition-colors placeholder:text-on-surface-variant/30 mb-3"
              placeholder="修改关键词重试..."
            />
          </div>
          <div className="flex gap-3 w-full">
            <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 font-label text-sm text-on-surface-variant hover:bg-surface-container-high transition-colors">
              Cancel
            </button>
            <button onClick={() => void doSearch(searchKeyword.trim(), true)} disabled={!searchKeyword.trim()} className="flex-1 py-3 rounded-xl bg-primary text-on-primary font-label text-sm font-bold hover:brightness-110 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed">
              Retry
            </button>
          </div>
        </div>
      )}

      {/* 成功提示 */}
      {state.status === 'queued' && (
        <div className="relative bg-surface-container w-full max-w-sm rounded-2xl border border-outline-variant/20 p-10 flex flex-col items-center gap-6 shadow-2xl">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-primary text-4xl leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          </div>
          <div className="text-center">
            <p className="font-label text-xs text-primary uppercase tracking-[0.2em] mb-2">Queued</p>
            <p className="font-body text-lg text-on-surface font-semibold">Added to download queue</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 状态机类型 ────────────────────────────────────────────────
type PageState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'results'; items: BgmSearchResult[] }
  | { status: 'loading' }
  | { status: 'detail'; data: BgmDetail }
  | { status: 'error'; message: string }

// ── 子组件 ────────────────────────────────────────────────────
function LoadingSpinner(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-32 gap-4">
      <span
        className="material-symbols-outlined text-primary/60 text-4xl animate-spin"
        style={{ animationDuration: '1.2s' }}
      >
        progress_activity
      </span>
      <p className="font-label text-xs text-on-surface-variant/40 tracking-widest uppercase">
        Accessing Archive...
      </p>
    </div>
  )
}

function IdleState(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-40 gap-6 opacity-40">
      <span className="material-symbols-outlined text-on-surface-variant text-6xl">
        manage_search
      </span>
      <div className="text-center">
        <p className="font-headline text-lg font-bold text-on-surface">
          Query the Archive
        </p>
        <p className="font-label text-xs text-on-surface-variant mt-1 tracking-wide">
          Type a title in the search bar above and press Enter
        </p>
      </div>
    </div>
  )
}

function SearchResults({
  items,
  onSelect,
}: {
  items: BgmSearchResult[]
  onSelect: (item: BgmSearchResult) => void
}): JSX.Element {
  return (
    <div className="max-w-3xl mx-auto">
      <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40 mb-6">
        {items.length} result{items.length !== 1 ? 's' : ''} found
      </p>
      <div className="space-y-2">
        {items.map((item) => (
          <button
            key={item.link}
            onClick={() => onSelect(item)}
            className="w-full flex items-center justify-between bg-surface-container hover:bg-surface-container-high border border-outline-variant/10 hover:border-primary/20 rounded-xl px-6 py-4 text-left transition-all duration-150 group"
          >
            <div>
              <p className="font-bold text-on-surface text-sm group-hover:text-primary transition-colors">
                {item.title}
              </p>
              <p className="font-label text-[11px] text-on-surface-variant/50 mt-0.5">
                {item.date || '日期未知'}
                {item.rate && item.rate !== 'N/A' && (
                  <span className="ml-3 text-primary/70">★ {item.rate}</span>
                )}
              </p>
            </div>
            <span className="material-symbols-outlined text-on-surface-variant/20 group-hover:text-primary/50 transition-colors text-lg">
              arrow_forward
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function DetailView({
  data,
  onBack,
  onArchive,
}: {
  data: BgmDetail
  onBack?: () => void
  onArchive?: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const hasStaff = data.staff.length > 0
  const displayTitle = (data.title_cn || data.title).toUpperCase()
  // 末尾单词高亮
  const words = displayTitle.split(' ')
  const lastWord = words.pop()
  const restTitle = words.join(' ')

  // 角色图标映射
  const roleIcon: Record<string, string> = {
    导演: 'videocam',
    监督: 'videocam',
    音乐: 'music_note',
    系列构成: 'edit_note',
    脚本: 'edit_note',
    人物设定: 'draw',
    人物原案: 'draw',
    总作画监督: 'brush',
    色彩脚本: 'palette',
    原作: 'book',
  }
  const getIcon = (role: string): string =>
    Object.entries(roleIcon).find(([k]) => role.includes(k))?.[1] ?? 'person'

  return (
    <div className="max-w-6xl mx-auto">
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-on-surface-variant/50 hover:text-primary transition-colors font-label text-xs uppercase tracking-wider mb-8 group"
        >
          <span className="material-symbols-outlined text-base leading-none group-hover:-translate-x-0.5 transition-transform">
            arrow_back
          </span>
          Back to results
        </button>
      )}
      <div className="grid grid-cols-12 gap-12 items-start">
        {/* ── 左栏：海报 + 按钮 ── */}
        <div className="col-span-4 sticky top-28">
          <div className="relative group mb-16">
            {/* 光晕 */}
            <div className="absolute -inset-4 bg-primary/5 rounded-xl blur-3xl opacity-0 group-hover:opacity-100 transition-opacity" />

            {/* 封面 */}
            {data.cover ? (
              <img
                src={data.cover}
                alt={data.title_cn || data.title}
                className="relative rounded-lg shadow-2xl w-full aspect-[2/3] object-cover"
              />
            ) : (
              <div className="relative rounded-lg w-full aspect-[2/3] bg-surface-container-high flex items-center justify-center">
                <span className="material-symbols-outlined text-on-surface-variant/20 text-6xl">
                  image
                </span>
              </div>
            )}

            {/* 评分浮层 */}
            <div className="absolute -bottom-6 -right-6 bg-surface-variant/70 backdrop-blur-2xl p-6 rounded-xl border border-outline-variant/15 shadow-2xl">
              <p className="font-label text-[10px] uppercase tracking-widest text-primary mb-1">
                Bangumi Rating
              </p>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-black text-on-surface tracking-tighter">
                  {data.score > 0 ? data.score.toFixed(1) : '--'}
                </span>
                <span className="text-on-surface-variant font-label text-sm">
                  / 10
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <button
              className="w-full py-4 rounded-full bg-gradient-to-r from-primary to-primary-container text-on-primary font-bold text-sm tracking-tight flex items-center justify-center gap-2 active:scale-95 transition-transform hover:brightness-110"
              onClick={onArchive}
            >
              <span className="material-symbols-outlined text-lg leading-none">
                download
              </span>
              Add to Archive
            </button>
            <button
              className="w-full py-4 rounded-full bg-secondary-container/30 hover:bg-secondary-container/50 border border-secondary/20 transition-colors font-label text-sm text-on-secondary-container"
              onClick={() => window.open(data.link, '_blank')}
            >
              Official Site
            </button>
          </div>
        </div>

        {/* ── 右栏：信息 ── */}
        <div className="col-span-8">
          {/* 状态徽章 */}
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 bg-secondary-container text-on-secondary-container font-label text-[10px] tracking-widest uppercase rounded-sm">
              {data.platform || 'TV Series'}
            </span>
            <span className="text-on-surface-variant font-label text-xs">
              {data.episodes > 0 ? `${data.episodes} Episodes` : ''}
              {data.tags.length > 0 && data.episodes > 0 ? ' · ' : ''}
              {data.tags.slice(0, 2).join(' · ')}
            </span>
          </div>

          {/* 标题 */}
          <h2 className="text-7xl font-black text-on-surface tracking-tighter leading-[0.9] mb-6">
            {restTitle && <>{restTitle}<br /></>}
            <span className="text-primary">{lastWord}</span>
          </h2>

          {/* Stats 行 */}
          <div className="flex gap-8 mb-12">
            <div>
              <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">
                Air Date
              </p>
              <p className="font-body font-bold text-on-surface">
                {data.date || '—'}
              </p>
            </div>
            {data.studio && (
              <div>
                <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">
                  Studio
                </p>
                <p className="font-body font-bold text-on-surface">
                  {data.studio}
                </p>
              </div>
            )}
            {data.tags.length > 0 && (
              <div>
                <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">
                  Genre
                </p>
                <p className="font-body font-bold text-on-surface">
                  {data.tags.slice(0, 3).join(' · ')}
                </p>
              </div>
            )}
          </div>

          {/* 简介 */}
          <div className="bg-surface-container rounded-xl p-10 mb-12">
            <h3 className="font-label text-xs text-primary uppercase tracking-[0.2em] mb-4">
              The Narrative
            </h3>
            <p className="text-on-surface-variant leading-relaxed text-xl font-light">
              {data.summary || 'No summary available for this entry.'}
            </p>
          </div>

          {/* Staff 区块 / 无 staff 占位 */}
          {hasStaff ? (
            <div>
              <h3 className="text-[10px] font-label text-on-surface-variant/40 tracking-widest uppercase mb-4">
                Staff
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {data.staff.map((s) => (
                  <div
                    key={s.role}
                    className="flex items-center space-x-3 bg-surface-container p-4 rounded-xl border border-outline-variant/20"
                  >
                    <div className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center flex-shrink-0">
                      <span className="material-symbols-outlined text-on-surface-variant/30 text-base leading-none">
                        {getIcon(s.role)}
                      </span>
                    </div>
                    <div>
                      <p className="text-[9px] font-label text-on-surface-variant/40 uppercase tracking-widest">
                        {s.role}
                      </p>
                      <p className="text-sm font-bold text-on-surface">
                        {s.name_cn || s.name}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="pt-8 border-t border-outline-variant/10">
              <div className="flex items-center gap-4 text-on-surface-variant/40">
                <span className="font-label text-[10px] uppercase tracking-[0.2em] whitespace-nowrap">
                  Metadata Record
                </span>
                <span className="h-px w-8 bg-outline-variant/20" />
                <p className="font-body text-xs italic">
                  Staff metadata is not included in this record.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 底部 Metadata Strip ── */}
      <div className="mt-20 pt-8 border-t border-outline-variant/10 flex justify-between items-center">
        <div className="flex gap-12">
          <div className="flex flex-col">
            <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
              Database ID
            </span>
            <span className="font-label text-sm font-bold">
              BGM-{data.id}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
              File Density
            </span>
            <span className="font-label text-sm font-bold">
              {data.episodes > 0 ? `${data.episodes} eps` : '—'}
              {data.platform ? ` · ${data.platform}` : ''}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
              Metadata Sync
            </span>
            <span className="font-label text-sm font-bold flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-secondary" />
              100% Secure
            </span>
          </div>
        </div>
        <button
          onClick={() => {
            navigator.clipboard.writeText(data.link)
            setCopied(true)
            setTimeout(() => setCopied(false), 3000)
          }}
          className="flex items-center gap-2 text-on-surface-variant hover:text-primary transition-colors font-label text-xs uppercase tracking-wider"
        >
          <span className="material-symbols-outlined text-lg leading-none">share</span>
          Export Record
        </button>
      </div>

      {/* ── 复制成功弹窗 ── */}
      {copied && (
        <div className="fixed inset-x-0 top-16 bottom-0 z-[200] flex items-center justify-center pointer-events-none">
          <div className="w-[340px] border border-outline-variant/30 rounded-2xl p-8 flex flex-col items-center gap-6 shadow-[0_0_50px_rgba(240,145,153,0.15)] bg-surface-container-high pointer-events-auto">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-4xl leading-none">
                check_circle
              </span>
            </div>
            <div className="text-center">
              <h4 className="font-label text-primary uppercase tracking-[0.2em] text-xs mb-2">
                Success
              </h4>
              <p className="font-body text-lg text-on-surface font-semibold leading-snug">
                Share link copied to clipboard
              </p>
            </div>
            <button
              onClick={() => setCopied(false)}
              className="mt-2 px-8 py-2.5 rounded-full bg-primary text-on-primary font-label text-xs font-black uppercase tracking-widest hover:brightness-110 transition-all active:scale-95 shadow-lg shadow-primary/20"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 模块级缓存：页面切换后恢复状态 ───────────────────────────
let _cachedState: PageState = { status: 'idle' }
let _cachedResults: BgmSearchResult[] = []
let _cachedBgmKeyword = ''

// ── 主页面 ────────────────────────────────────────────────────
function AnimeInfo(): JSX.Element {
  const [state, setState] = useState<PageState>(_cachedState)
  const lastResults = { current: _cachedResults }
  const lastBgmKeyword = useRef(_cachedBgmKeyword)
  const [archiveKeyword, setArchiveKeyword] = useState<string | null>(null)

  useEffect(() => {
    _cachedState = state
  }, [state])

  const handleSearch = async (keyword: string): Promise<void> => {
    lastBgmKeyword.current = keyword
    _cachedBgmKeyword = keyword
    setState({ status: 'searching' })
    try {
      const results = await window.bgmApi.search(keyword)
      results.sort((a, b) => {
        const da = /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : '0000-00-00'
        const db = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '0000-00-00'
        return db.localeCompare(da)
      })
      if (results.length === 0) {
        setState({ status: 'error', message: `未找到与"${keyword}"相关的结果` })
      } else if (results.length === 1) {
        lastResults.current = []
        _cachedResults = []
        await loadDetail(results[0])
      } else {
        lastResults.current = results
        _cachedResults = results
        setState({ status: 'results', items: results })
      }
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    }
  }

  const loadDetail = async (item: BgmSearchResult): Promise<void> => {
    const sid = extractSubjectId(item.link)
    if (!sid) {
      setState({ status: 'error', message: 'Could not parse subject ID from link.' })
      return
    }
    setState({ status: 'loading' })
    try {
      const detail = await window.bgmApi.detail(sid)
      setState({ status: 'detail', data: detail })
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <TopBar placeholder="Lookup titles from bgm.tv..." onSearch={handleSearch} />

      <main className="ml-0 pt-16 px-10 py-10">
        {state.status === 'idle' && <IdleState />}
        {(state.status === 'searching' || state.status === 'loading') && <LoadingSpinner />}
        {state.status === 'results' && (
          <SearchResults items={state.items} onSelect={loadDetail} />
        )}
        {state.status === 'detail' && (
          <DetailView
            data={state.data}
            onBack={
              lastResults.current.length > 0
                ? () => setState({ status: 'results', items: lastResults.current })
                : undefined
            }
            onArchive={() => setArchiveKeyword(lastBgmKeyword.current || state.data.title_cn || state.data.title)}
          />
        )}
        {state.status === 'error' && (
          <div className="flex flex-col items-center justify-center py-32 gap-4 opacity-60">
            <span className="material-symbols-outlined text-error text-4xl">
              error_outline
            </span>
            <p className="font-label text-xs text-on-surface-variant tracking-wide">
              {state.message}
            </p>
            <button
              onClick={() => setState({ status: 'idle' })}
              className="mt-2 font-label text-[11px] text-primary/70 hover:text-primary underline underline-offset-4"
            >
              Try again
            </button>
          </div>
        )}
      </main>

      {/* Archive 流程叠加层 */}
      {archiveKeyword !== null && (
        <ArchiveFlow
          keyword={archiveKeyword}
          onClose={() => setArchiveKeyword(null)}
        />
      )}
    </div>
  )
}

export default AnimeInfo
