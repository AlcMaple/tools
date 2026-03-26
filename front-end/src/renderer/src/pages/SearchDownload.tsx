import { useState, useRef, useEffect } from 'react'
import TopBar from '../components/TopBar'
import type { XifanSearchResult, XifanWatchInfo } from '../types/xifan'
import { downloadStore } from '../stores/downloadStore'

// ── Module-level cache (persists across component unmount/remount) ─────────────

let _cachedState: PageState = { status: 'idle' }
let _cachedSearchQuery = ''
let _cachedKeyword = ''

// ── localStorage search/watch cache ──────────────────────────────────────────

function isSearchCacheEnabled(): boolean {
  try {
    return JSON.parse(localStorage.getItem('xifan_settings') || '{}').searchCacheEnabled !== false
  } catch { return true }
}

function getCachedSearch(keyword: string): XifanSearchResult[] | null {
  try {
    return (JSON.parse(localStorage.getItem('xifan_search_cache') || '{}') as Record<string, XifanSearchResult[]>)[keyword] ?? null
  } catch { return null }
}

function setCachedSearch(keyword: string, results: XifanSearchResult[]): void {
  try {
    const cache = JSON.parse(localStorage.getItem('xifan_search_cache') || '{}') as Record<string, XifanSearchResult[]>
    cache[keyword] = results
    localStorage.setItem('xifan_search_cache', JSON.stringify(cache))
  } catch { /* ignore */ }
}

function getCachedWatch(url: string): XifanWatchInfo | null {
  try {
    return (JSON.parse(localStorage.getItem('xifan_watch_cache') || '{}') as Record<string, XifanWatchInfo>)[url] ?? null
  } catch { return null }
}

function setCachedWatch(url: string, info: XifanWatchInfo): void {
  try {
    const cache = JSON.parse(localStorage.getItem('xifan_watch_cache') || '{}') as Record<string, XifanWatchInfo>
    cache[url] = info
    localStorage.setItem('xifan_watch_cache', JSON.stringify(cache))
  } catch { /* ignore */ }
}

// ── State machine ──────────────────────────────────────────────────────────────

type PageState =
  | { status: 'idle' }
  | { status: 'captcha'; imageB64: string; keyword: string; captchaError?: string }
  | { status: 'verifying'; keyword: string }
  | { status: 'searching' }
  | { status: 'results'; items: XifanSearchResult[]; keyword: string }
  | { status: 'download_config'; items: XifanSearchResult[]; item: XifanSearchResult; watchInfo: XifanWatchInfo }
  | { status: 'error'; message: string }

// ── Sub-components ────────────────────────────────────────────────────────────

function ImagePlaceholder({ className = '' }: { className?: string }): JSX.Element {
  return (
    <div className={`bg-surface-container-high flex items-center justify-center ${className}`}>
      <span className="material-symbols-outlined text-on-surface-variant/20 text-4xl">movie</span>
    </div>
  )
}

function SearchingState(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-6">
      <div className="w-12 h-12 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <p className="font-label text-xs text-on-surface-variant/50 tracking-widest uppercase">
        Indexing archives...
      </p>
    </div>
  )
}

// ── Download Config Modal ─────────────────────────────────────────────────────

interface DownloadConfigProps {
  item: XifanSearchResult
  watchInfo: XifanWatchInfo
  onClose: () => void
  onStart: (templates: string[], startEp: number, endEp: number) => void
}

function DownloadConfigModal({ item, watchInfo, onClose, onStart }: DownloadConfigProps): JSX.Element {
  const validSources = watchInfo.sources.filter((s) => s.template)
  const [selectedIdx, setSelectedIdx] = useState(validSources[0]?.idx ?? 1)
  // Use string state so users can freely edit; clamp only on blur / submit
  const [startStr, setStartStr] = useState('1')
  const [endStr, setEndStr] = useState(String(watchInfo.total))

  const clampStart = (s: string): number =>
    Math.max(1, Math.min(watchInfo.total, parseInt(s, 10) || 1))
  const clampEnd = (s: string, start: number): number =>
    Math.max(start, Math.min(watchInfo.total, parseInt(s, 10) || watchInfo.total))

  const handleStart = (): void => {
    const selected = validSources.find((s) => s.idx === selectedIdx)
    if (!selected?.template) return
    const s = clampStart(startStr)
    const e = clampEnd(endStr, s)
    onStart([selected.template], s, e)
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-container-lowest/60 backdrop-blur-sm">
      <div className="bg-surface-container w-full max-w-lg rounded-xl border border-outline-variant/20 p-8">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h3 className="font-headline font-black text-lg text-on-surface tracking-tight">
              {watchInfo.title || item.title}
            </h3>
            <p className="font-label text-xs text-on-surface-variant/50 mt-1 tracking-widest uppercase">
              {watchInfo.total} Episodes · Configure Download
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high transition-colors text-on-surface-variant/60"
          >
            <span className="material-symbols-outlined text-xl leading-none">close</span>
          </button>
        </div>

        {/* Source selector */}
        {validSources.length > 0 ? (
          <div className="mb-6">
            <p className="font-label text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-3">
              Download Source
            </p>
            <div className="space-y-2">
              {validSources.map((src) => (
                <label
                  key={src.idx}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedIdx === src.idx
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-outline-variant/20 hover:bg-surface-container-high'
                  }`}
                >
                  <input
                    type="radio"
                    name="source"
                    value={src.idx}
                    checked={selectedIdx === src.idx}
                    onChange={() => setSelectedIdx(src.idx)}
                    className="accent-primary"
                  />
                  <span className="font-label text-sm text-on-surface">{src.name}</span>
                  <span className="ml-auto font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest">
                    Source {src.idx}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <div className="mb-6 p-4 rounded-lg bg-error/10 border border-error/20">
            <p className="font-label text-xs text-error">
              No valid download sources found for this title.
            </p>
          </div>
        )}

        {/* Episode range */}
        <div className="mb-8">
          <p className="font-label text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-3">
            Episode Range
          </p>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest block mb-1.5">
                From
              </label>
              <input
                type="number"
                min={1}
                max={watchInfo.total}
                value={startStr}
                onChange={(e) => setStartStr(e.target.value)}
                onBlur={() => setStartStr(String(clampStart(startStr)))}
                className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg px-3 py-2.5 text-sm font-label text-on-surface outline-none focus:border-primary/40 transition-colors"
              />
            </div>
            <span className="text-on-surface-variant/30 mt-5">—</span>
            <div className="flex-1">
              <label className="font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest block mb-1.5">
                To
              </label>
              <input
                type="number"
                min={1}
                max={watchInfo.total}
                value={endStr}
                onChange={(e) => setEndStr(e.target.value)}
                onBlur={() => setEndStr(String(clampEnd(endStr, clampStart(startStr))))}
                className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg px-3 py-2.5 text-sm font-label text-on-surface outline-none focus:border-primary/40 transition-colors"
              />
            </div>
            <div className="mt-5">
              <span className="font-label text-[10px] text-on-surface-variant/30">
                / {watchInfo.total}
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={validSources.length === 0}
            className="flex-1 py-3 rounded-xl primary-gradient text-on-primary text-sm font-black tracking-widest hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base leading-none">bolt</span>
            START DOWNLOAD
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

function SearchDownload(): JSX.Element {
  const [state, setState] = useState<PageState>(() => {
    // Restore to results/idle only — don't restore mid-flight states
    const s = _cachedState
    if (s.status === 'searching' || s.status === 'verifying') return { status: 'idle' }
    if (s.status === 'download_config') return { status: 'results', items: s.items, keyword: _cachedKeyword }
    return s
  })
  const [source, setSource] = useState('Xifan')
  const [searchQuery, setSearchQuery] = useState(() => _cachedSearchQuery)
  const [captchaInput, setCaptchaInput] = useState('')
  const [loadingWatchUrl, setLoadingWatchUrl] = useState<string | null>(null)
  const [downloadStarted, setDownloadStarted] = useState(false)
  const currentKeyword = useRef(_cachedKeyword)

  // Sync state back to module-level cache whenever it changes
  useEffect(() => { _cachedState = state }, [state])
  useEffect(() => { _cachedSearchQuery = searchQuery }, [searchQuery])
  useEffect(() => { _cachedKeyword = currentKeyword.current }, [state])

  const handleSearch = async (keyword: string): Promise<void> => {
    if (!keyword.trim()) return
    currentKeyword.current = keyword
    setSearchQuery(keyword)

    // Return cached results immediately if cache is enabled
    if (isSearchCacheEnabled()) {
      const cached = getCachedSearch(keyword)
      if (cached) {
        setState({ status: 'results', items: cached, keyword })
        return
      }
    }

    setState({ status: 'searching' })
    try {
      const result = await window.xifanApi.search(keyword)
      if (!Array.isArray(result) && result.needs_captcha) {
        const { image_b64 } = await window.xifanApi.getCaptcha()
        setCaptchaInput('')
        setState({ status: 'captcha', imageB64: image_b64, keyword })
      } else if (Array.isArray(result)) {
        setCachedSearch(keyword, result)
        setState({ status: 'results', items: result, keyword })
      }
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    }
  }

  const handleRefreshCaptcha = async (): Promise<void> => {
    if (state.status !== 'captcha') return
    try {
      const { image_b64 } = await window.xifanApi.getCaptcha()
      setCaptchaInput('')
      setState({ ...state, imageB64: image_b64, captchaError: undefined })
    } catch {
      // silently fail
    }
  }

  const handleVerify = async (): Promise<void> => {
    if (state.status !== 'captcha') return
    const keyword = state.keyword
    setState({ status: 'verifying', keyword })
    try {
      const { success } = await window.xifanApi.verifyCaptcha(captchaInput.trim())
      if (success) {
        setState({ status: 'searching' })
        const result = await window.xifanApi.search(keyword)
        if (Array.isArray(result)) {
          setState({ status: 'results', items: result, keyword })
        } else {
          // Verification succeeded but still needs captcha – shouldn't happen normally
          const { image_b64 } = await window.xifanApi.getCaptcha()
          setCaptchaInput('')
          setState({ status: 'captcha', imageB64: image_b64, keyword, captchaError: 'Verification failed, please retry.' })
        }
      } else {
        const { image_b64 } = await window.xifanApi.getCaptcha()
        setCaptchaInput('')
        setState({ status: 'captcha', imageB64: image_b64, keyword, captchaError: 'Wrong code, try again.' })
      }
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    }
  }

  const handleDownloadClick = async (item: XifanSearchResult): Promise<void> => {
    if (state.status !== 'results') return

    // Return cached watch info immediately if cache is enabled
    if (isSearchCacheEnabled()) {
      const cached = getCachedWatch(item.watch_url)
      if (cached) {
        setState({ status: 'download_config', items: state.items, item, watchInfo: cached })
        return
      }
    }

    setLoadingWatchUrl(item.watch_url)
    try {
      const watchInfo = await window.xifanApi.getWatch(item.watch_url)
      if (watchInfo.error) {
        alert(`Failed to load sources: ${watchInfo.error}`)
        return
      }
      setCachedWatch(item.watch_url, watchInfo)
      setState({ status: 'download_config', items: state.items, item, watchInfo })
    } catch (err) {
      alert(`Error: ${err}`)
    } finally {
      setLoadingWatchUrl(null)
    }
  }

  const handleStartDownload = async (templates: string[], startEp: number, endEp: number): Promise<void> => {
    if (state.status !== 'download_config') return
    const { item, items, watchInfo } = state
    const title = watchInfo.title || item.title
    try {
      const { taskId, pid } = await window.xifanApi.startDownload(title, templates, startEp, endEp)
      // Build initial epStatus: all episodes start as pending
      const epStatus: Record<number, 'pending' | 'downloading' | 'done' | 'error'> = {}
      for (let ep = startEp; ep <= endEp; ep++) epStatus[ep] = 'pending'
      downloadStore.addTask({
        id: taskId,
        title,
        cover: item.cover,
        startEp,
        endEp,
        templates,
        status: 'running',
        epStatus,
        epProgress: {},
        startedAt: Date.now(),
        pid,
      })
      setDownloadStarted(true)
      setTimeout(() => setDownloadStarted(false), 3000)
      setState({ status: 'results', items, keyword: currentKeyword.current })
    } catch (err) {
      alert(`Download error: ${err}`)
    }
  }

  const isSearching = state.status === 'searching' || state.status === 'verifying'

  return (
    <div className="min-h-full bg-background">
      <TopBar placeholder="Quick find archives..." onSearch={handleSearch} />

      <main className="pt-16 px-8 py-8">
        {/* Hero Section */}
        <section className="mt-10 mb-12">
          <p className="font-label text-xs text-primary/70 tracking-[0.3em] uppercase mb-3">
            Multisource Downloader
          </p>
          <h1 className="text-7xl font-black leading-none tracking-tighter text-on-surface mb-4">
            INDEX THE <span className="text-primary">MULTIVERSE</span>
          </h1>
          <p className="text-on-surface-variant/60 text-sm max-w-lg font-label">
            Search and retrieve anime from multiple sources simultaneously. Automated pipeline from
            search to archive.
          </p>
        </section>

        {/* Search Bar */}
        <section className="mb-10">
          <div className="flex items-center gap-3 max-w-3xl">
            <div className="flex-1 flex items-center bg-surface-container-highest rounded-xl px-5 py-3.5 space-x-3 border border-outline-variant/30 focus-within:border-primary/40 transition-colors">
              <span className="material-symbols-outlined text-primary text-xl leading-none">
                travel_explore
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch(searchQuery)}
                placeholder="Enter anime title or keyword..."
                className="flex-1 bg-transparent text-on-surface placeholder-on-surface-variant/40 outline-none text-sm font-label"
              />
            </div>

            {/* Source selector */}
            <div className="relative">
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="appearance-none bg-surface-container-highest border border-outline-variant/30 text-on-surface text-sm font-label rounded-xl px-4 py-3.5 pr-8 outline-none cursor-pointer hover:border-primary/40 transition-colors"
              >
                <option value="Xifan">Xifan</option>
                <option value="Girigiri" disabled>
                  Girigiri (开发中)
                </option>
              </select>
              <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-sm pointer-events-none leading-none">
                expand_more
              </span>
            </div>

            <button
              onClick={() => handleSearch(searchQuery)}
              disabled={isSearching}
              className="primary-gradient text-on-primary font-black text-sm tracking-widest px-7 py-3.5 rounded-xl hover:opacity-90 transition-opacity flex items-center space-x-2 disabled:opacity-50"
            >
              {isSearching ? (
                <div className="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin" />
              ) : (
                <span className="material-symbols-outlined text-base leading-none">bolt</span>
              )}
              <span>INITIALIZE</span>
            </button>
          </div>
        </section>

        {/* Download started toast */}
        {downloadStarted && (
          <div className="fixed bottom-8 right-8 z-50 bg-surface-container-high border border-outline-variant/20 rounded-xl px-5 py-3 flex items-center gap-3 shadow-lg">
            <span className="material-symbols-outlined text-primary text-lg leading-none">
              check_circle
            </span>
            <span className="font-label text-sm text-on-surface">Download started in background</span>
          </div>
        )}

        {/* Results area */}
        {state.status === 'idle' && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-on-surface-variant/20">
            <span className="material-symbols-outlined text-6xl">travel_explore</span>
            <p className="font-label text-xs tracking-widest uppercase">
              Enter a keyword to begin
            </p>
          </div>
        )}

        {state.status === 'searching' && <SearchingState />}

        {state.status === 'error' && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <span className="material-symbols-outlined text-error/60 text-5xl">error_outline</span>
            <p className="font-label text-sm text-error/80">{state.message}</p>
            <button
              onClick={() => setState({ status: 'idle' })}
              className="font-label text-xs text-primary hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        {state.status === 'results' && state.items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <span className="material-symbols-outlined text-on-surface-variant/20 text-6xl">
              search_off
            </span>
            <p className="font-label text-sm text-on-surface-variant/50">
              No results found for{' '}
              <span className="text-primary">"{state.keyword}"</span>
            </p>
          </div>
        )}

        {(state.status === 'results' || state.status === 'download_config') && state.items.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xs font-label text-on-surface-variant/50 tracking-widest uppercase">
                Search Results —{' '}
                {state.status === 'results' ? state.items.length : state.items.length} entries found
                {' · '}
                <span className="text-primary/60">{currentKeyword.current}</span>
              </h2>
              <div className="flex items-center space-x-2 text-xs font-label text-on-surface-variant/40">
                <span className="material-symbols-outlined text-sm leading-none">filter_list</span>
                <span>Sort by relevance</span>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4">
              {(state.status === 'results' ? state.items : state.items).map((card, idx) => (
                <div
                  key={idx}
                  className="group relative bg-surface-container rounded-xl overflow-hidden border border-outline-variant/20 hover:border-primary/30 transition-all duration-300"
                >
                  {/* Poster */}
                  <div className="aspect-[2/3] relative overflow-hidden">
                    {card.cover ? (
                      <img
                        src={card.cover}
                        alt={card.title}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    ) : (
                      <ImagePlaceholder className="w-full h-full" />
                    )}

                    {/* Loading spinner overlay */}
                    {loadingWatchUrl === card.watch_url && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                      </div>
                    )}

                    {/* Hover overlay */}
                    {loadingWatchUrl !== card.watch_url && (
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">
                        <button
                          onClick={() => handleDownloadClick(card)}
                          className="w-full primary-gradient text-on-primary text-xs font-black tracking-widest py-2.5 rounded-lg mb-2 flex items-center justify-center space-x-1.5"
                        >
                          <span className="material-symbols-outlined text-sm leading-none">
                            download
                          </span>
                          <span>DOWNLOAD</span>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Card footer */}
                  <div className="p-3">
                    <h3 className="text-sm font-bold text-on-surface truncate mb-1">
                      {card.title}
                    </h3>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-label text-on-surface-variant/50">
                        {card.year}
                        {card.area ? ` · ${card.area}` : ''}
                      </span>
                      <span className="text-xs font-label text-primary/70">{card.episode}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* CAPTCHA Modal */}
      {(state.status === 'captcha' || state.status === 'verifying') && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-surface-container-lowest/40 backdrop-blur-sm">
          <div className="glass-effect w-full max-w-md rounded-xl p-8 border border-outline-variant/30">
            {/* Header */}
            <div className="flex items-start justify-between mb-6">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-primary text-xl leading-none">
                    security
                  </span>
                </div>
                <div>
                  <h3 className="text-sm font-black tracking-wider text-on-surface">
                    CRAWLER VERIFICATION
                  </h3>
                  <p className="text-[10px] font-label text-on-surface-variant/50 mt-0.5">
                    Source: Xifan ACG
                  </p>
                </div>
              </div>
              <button
                onClick={() => setState({ status: 'idle' })}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors text-on-surface-variant/60 hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-xl leading-none">close</span>
              </button>
            </div>

            {/* CAPTCHA image */}
            <div className="aspect-video rounded-lg overflow-hidden mb-4 relative bg-surface-container-high">
              {state.status === 'captcha' && state.imageB64 ? (
                <img
                  src={`data:image/jpeg;base64,${state.imageB64}`}
                  alt="CAPTCHA"
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                </div>
              )}
            </div>

            {/* Error message */}
            {state.status === 'captcha' && state.captchaError && (
              <p className="text-xs font-label text-error mb-3">{state.captchaError}</p>
            )}

            {/* Refresh */}
            <button
              onClick={handleRefreshCaptcha}
              disabled={state.status === 'verifying'}
              className="flex items-center space-x-1.5 text-xs font-label text-on-surface-variant/50 hover:text-primary transition-colors mb-5 disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-sm leading-none">refresh</span>
              <span>Refresh image</span>
            </button>

            {/* Input */}
            <div className="mb-6">
              <input
                type="text"
                value={captchaInput}
                onChange={(e) => setCaptchaInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
                placeholder="Enter characters above..."
                disabled={state.status === 'verifying'}
                className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-sm font-label text-on-surface placeholder-on-surface-variant/40 outline-none focus:border-primary/40 transition-colors tracking-[0.3em] disabled:opacity-50"
              />
            </div>

            {/* Actions */}
            <div className="flex items-center space-x-3">
              <button
                onClick={() => setState({ status: 'idle' })}
                className="flex-1 py-3 rounded-xl border border-outline-variant/30 text-sm font-label text-on-surface-variant hover:bg-surface-container transition-colors"
              >
                CANCEL
              </button>
              <button
                onClick={handleVerify}
                disabled={state.status === 'verifying' || !captchaInput.trim()}
                className="flex-1 py-3 rounded-xl primary-gradient text-on-primary text-sm font-black tracking-widest hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {state.status === 'verifying' && (
                  <div className="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin" />
                )}
                VERIFY
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Download Config Modal */}
      {state.status === 'download_config' && (
        <DownloadConfigModal
          item={state.item}
          watchInfo={state.watchInfo}
          onClose={() =>
            setState({ status: 'results', items: state.items, keyword: currentKeyword.current })
          }
          onStart={handleStartDownload}
        />
      )}
    </div>
  )
}

export default SearchDownload
