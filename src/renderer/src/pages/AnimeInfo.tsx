import { useState, useEffect, useRef } from 'react'
import TopBar from '../components/TopBar'
import ErrorPanel from '../components/ErrorPanel'
import type { BgmSearchResult, BgmDetail } from '../types/bgm'
import type { XifanWatchInfo } from '../types/xifan'
import type { GirigiriEpisode, GirigiriWatchInfo } from '../types/girigiri'
import type { AowuEpisode, AowuWatchInfo } from '../types/aowu'
import type { Source, SearchCard } from '../types/search'
import { normalizeXifan, normalizeGirigiri, normalizeAowu } from '../utils/searchNormalize'
import { XifanDownloadConfigModal } from '../components/XifanDownloadModal'
import { GirigiriDownloadConfigModal } from '../components/GirigiriDownloadModal'
import { AowuDownloadConfigModal } from '../components/AowuDownloadModal'
import { downloadStore } from '../stores/downloadStore'
import { readCacheEntry, dedupRefresh } from '../utils/searchCache'

const DAY_MS = 24 * 60 * 60 * 1000
const BGM_SEARCH_TTL_MS = 14 * DAY_MS

// ── 工具函数 ──────────────────────────────────────────────────
function extractSubjectId(link: string): number | null {
  const m = link.match(/\/subject\/(\d+)/)
  return m ? parseInt(m[1]) : null
}

// ── Archive 缓存（per-source）─────────────────────────────────

// ArchiveFlow 各源的缓存独立，存的是统一后的 SearchCard
const archiveCacheKey = (source: Source): string =>
  `archive_search_cache_${source.toLowerCase()}`

const sharedSearchCacheKey = (source: Source): string =>
  `search_cache_${source.toLowerCase()}`

async function getSearchCache(source: Source, keyword: string): Promise<SearchCard[] | null> {
  try {
    const c = (await window.systemApi.cacheGet(archiveCacheKey(source))) as Record<string, SearchCard[]> | null
    if (c?.[keyword]) return c[keyword]
  } catch { /* noop */ }

  // 兼容 SearchDownload 写入的共享缓存
  try {
    const sd = (await window.systemApi.cacheGet(sharedSearchCacheKey(source))) as Record<string, unknown> | null
    const entry = sd ? readCacheEntry<SearchCard[]>(sd[keyword]) : null
    if (entry && Array.isArray(entry.data) && entry.data.length > 0) return entry.data
  } catch { /* noop */ }

  return null
}

async function setSearchCache(source: Source, keyword: string, cards: SearchCard[]): Promise<void> {
  try {
    const c = ((await window.systemApi.cacheGet(archiveCacheKey(source))) as Record<string, SearchCard[]>) || {}
    c[keyword] = cards
    await window.systemApi.cacheSet(archiveCacheKey(source), c)
  } catch { /* noop */ }
}

function getSavePath(): string | undefined {
  try { return JSON.parse(localStorage.getItem('xifan_settings') || '{}').downloadPath || undefined } catch { return undefined }
}

// ── BGM 搜索结果缓存 ──────────────────────────────────────────
const BGM_SEARCH_CACHE_KEY = 'search_cache_bgm'

function isSearchCacheEnabled(): boolean {
  try {
    return JSON.parse(localStorage.getItem('xifan_settings') || '{}').searchCacheEnabled !== false
  } catch { return true }
}

interface BgmSearchHit { data: BgmSearchResult[]; isStale: boolean }

async function getCachedBgmSearch(keyword: string): Promise<BgmSearchHit | null> {
  try {
    const c = (await window.systemApi.cacheGet(BGM_SEARCH_CACHE_KEY)) as Record<string, unknown> | null
    if (!c) return null
    const entry = readCacheEntry<BgmSearchResult[]>(c[keyword])
    if (!entry) return null
    return { data: entry.data, isStale: Date.now() - entry.updatedAt > BGM_SEARCH_TTL_MS }
  } catch { return null }
}

async function setCachedBgmSearch(keyword: string, items: BgmSearchResult[]): Promise<void> {
  try {
    await window.systemApi.cacheSet(BGM_SEARCH_CACHE_KEY, keyword, {
      data: items,
      updatedAt: Date.now(),
    })
  } catch { /* noop */ }
}

const BGM_DETAIL_CACHE_KEY = 'bgm_detail_cache'

async function getCachedBgmDetail(subjectId: number): Promise<BgmDetail | null> {
  try {
    const c = (await window.systemApi.cacheGet(BGM_DETAIL_CACHE_KEY)) as Record<string, BgmDetail> | null
    return c?.[String(subjectId)] ?? null
  } catch { return null }
}

async function setCachedBgmDetail(subjectId: number, detail: BgmDetail): Promise<void> {
  try {
    const c = ((await window.systemApi.cacheGet(BGM_DETAIL_CACHE_KEY)) as Record<string, BgmDetail>) || {}
    c[String(subjectId)] = detail
    await window.systemApi.cacheSet(BGM_DETAIL_CACHE_KEY, c)
  } catch { /* noop */ }
}


// ── ArchiveFlow ───────────────────────────────────────────────
// 独立状态机，叠加在页面上处理完整的搜索→验证→配置→下载流程

type ArchiveCaptchaSource = 'Xifan' | 'Girigiri'

const ARCHIVE_SOURCE_KEY = 'maple-archive-source'

function readArchiveSource(): Source {
  const v = localStorage.getItem(ARCHIVE_SOURCE_KEY)
  return v === 'Xifan' || v === 'Girigiri' ? v : 'Aowu'
}

type ArchiveFlowState =
  // pickSource — 流程的第一站：让用户确认/切换本次添加要走哪个源
  | { status: 'pickSource'; selected: Source }
  | { status: 'searching' }
  | { status: 'captcha'; imageB64: string; captchaSource: ArchiveCaptchaSource; error?: string }
  | { status: 'verifying'; captchaSource: ArchiveCaptchaSource }
  | { status: 'results'; cards: SearchCard[] }
  | { status: 'loadingWatch'; card: SearchCard }
  | { status: 'xifan_config'; card: SearchCard; watchInfo: XifanWatchInfo }
  | { status: 'girigiri_config'; card: SearchCard; watchInfo: GirigiriWatchInfo }
  | { status: 'aowu_config'; card: SearchCard; watchInfo: AowuWatchInfo }
  | { status: 'queued' }
  | { status: 'error'; message: string }

function ArchiveFlow({ keyword: initialKeyword, onClose }: {
  keyword: string
  onClose: () => void
}): JSX.Element {
  // Source 在 pickSource 步骤之后被锁定为本次选择，并写回 localStorage 供下次预选
  const [source, setSource] = useState<Source>(() => readArchiveSource())
  const [state, setState] = useState<ArchiveFlowState>(() => ({ status: 'pickSource', selected: readArchiveSource() }))
  const [captchaInput, setCaptchaInput] = useState('')
  const [searchKeyword, setSearchKeyword] = useState(initialKeyword)
  const activeKeyword = useRef(initialKeyword)

  // 选源确认后再开始搜索
  function confirmSource(picked: Source): void {
    setSource(picked)
    localStorage.setItem(ARCHIVE_SOURCE_KEY, picked)
    void doSearch(initialKeyword, false, picked)
  }

  async function doSearch(kw: string, skipCache = false, src: Source = source): Promise<void> {
    activeKeyword.current = kw
    setSearchKeyword(kw)
    setState({ status: 'searching' })

    if (!skipCache) {
      const cached = await getSearchCache(src, kw)
      if (cached && cached.length > 0) { handleResults(kw, cached, src); return }
    }

    try {
      if (src === 'Aowu') {
        const result = await window.aowuApi.search(kw)
        const cards = result.map(normalizeAowu)
        if (cards.length > 0) void setSearchCache(src, kw, cards)
        handleResults(kw, cards, src)
      } else if (src === 'Girigiri') {
        const result = await window.girigiriApi.search(kw)
        if (!Array.isArray(result) && result.needs_captcha) {
          const { image_b64 } = await window.girigiriApi.getCaptcha()
          setCaptchaInput('')
          setState({ status: 'captcha', imageB64: image_b64, captchaSource: 'Girigiri' })
        } else if (Array.isArray(result)) {
          const cards = result.map(normalizeGirigiri)
          if (cards.length > 0) void setSearchCache(src, kw, cards)
          handleResults(kw, cards, src)
        } else {
          setState({ status: 'error', message: `Girigiri 返回了意外的响应` })
        }
      } else {
        const result = await window.xifanApi.search(kw)
        if (!Array.isArray(result) && result.needs_captcha) {
          const { image_b64 } = await window.xifanApi.getCaptcha()
          setCaptchaInput('')
          setState({ status: 'captcha', imageB64: image_b64, captchaSource: 'Xifan' })
        } else if (Array.isArray(result)) {
          const cards = result.map(normalizeXifan)
          if (cards.length > 0) void setSearchCache(src, kw, cards)
          handleResults(kw, cards, src)
        } else {
          setState({ status: 'error', message: `Xifan 返回了意外的响应` })
        }
      }
    } catch (err) {
      setState({ status: 'error', message: `Search failed: ${String(err)}` })
    }
  }

  function handleResults(kw: string, cards: SearchCard[], src: Source = source): void {
    if (cards.length === 0) {
      setState({ status: 'error', message: `${src} 未找到与"${kw}"相关的结果` })
      return
    }
    if (cards.length === 1) { void loadWatch(cards[0]); return }
    setState({ status: 'results', cards })
  }

  async function loadWatch(card: SearchCard): Promise<void> {
    setState({ status: 'loadingWatch', card })
    try {
      if (card.source === 'Aowu') {
        const watchInfo = await window.aowuApi.getWatch(card.key)
        if (watchInfo.error) { setState({ status: 'error', message: String(watchInfo.error) }); return }
        setState({ status: 'aowu_config', card, watchInfo })
      } else if (card.source === 'Girigiri') {
        const watchInfo = await window.girigiriApi.getWatch(card.key)
        if (watchInfo.error) { setState({ status: 'error', message: String(watchInfo.error) }); return }
        setState({ status: 'girigiri_config', card, watchInfo })
      } else {
        const watchInfo = await window.xifanApi.getWatch(card.key)
        const wErr = (watchInfo as { error?: unknown }).error
        if (wErr) { setState({ status: 'error', message: String(wErr) }); return }
        setState({ status: 'xifan_config', card, watchInfo })
      }
    } catch (err) {
      setState({ status: 'error', message: `Failed to load sources: ${String(err)}` })
    }
  }

  async function handleVerify(): Promise<void> {
    if (state.status !== 'captcha') return
    const captchaSource = state.captchaSource
    setState({ status: 'verifying', captchaSource })
    try {
      const api = captchaSource === 'Girigiri' ? window.girigiriApi : window.xifanApi
      const { success } = await api.verifyCaptcha(captchaInput.trim())
      if (success) {
        await doSearch(activeKeyword.current, true)
      } else {
        const { image_b64 } = await api.getCaptcha()
        setCaptchaInput('')
        setState({ status: 'captcha', imageB64: image_b64, captchaSource, error: 'Wrong code, try again.' })
      }
    } catch { onClose() }
  }

  async function handleRefreshCaptcha(): Promise<void> {
    if (state.status !== 'captcha') return
    try {
      const api = state.captchaSource === 'Girigiri' ? window.girigiriApi : window.xifanApi
      const { image_b64 } = await api.getCaptcha()
      setCaptchaInput('')
      setState({ status: 'captcha', imageB64: image_b64, captchaSource: state.captchaSource })
    } catch { /* noop */ }
  }

  async function handleStartXifanDownload(templates: string[], startEp: number, endEp: number): Promise<void> {
    if (state.status !== 'xifan_config') return
    const { card, watchInfo } = state
    const title = watchInfo.title || card.title
    const savePath = getSavePath()
    try {
      const { taskId } = await window.xifanApi.startDownload(title, templates, startEp, endEp, savePath)
      const epStatus: Record<number, 'pending'> = {}
      for (let ep = startEp; ep <= endEp; ep++) epStatus[ep] = 'pending'
      downloadStore.addTask({
        id: taskId, source: 'xifan', title, cover: card.cover,
        startEp, endEp, templates, savePath,
        status: 'running', epStatus, epProgress: {}, startedAt: Date.now(),
      })
      setState({ status: 'queued' })
      setTimeout(onClose, 2000)
    } catch (err) { alert(`Download error: ${err}`) }
  }

  async function handleStartGirigiriDownload(selectedEps: GirigiriEpisode[]): Promise<void> {
    if (state.status !== 'girigiri_config') return
    const { card, watchInfo } = state
    const title = watchInfo.title || card.title
    const savePath = getSavePath()
    const selectedIdxs = selectedEps.map(e => e.idx)
    try {
      const { taskId } = await window.girigiriApi.startDownload(title, selectedEps, selectedIdxs, savePath)
      const epStatus: Record<number, 'pending'> = {}
      for (const idx of selectedIdxs) epStatus[idx] = 'pending'
      downloadStore.addTask({
        id: taskId, source: 'girigiri', title, cover: card.cover,
        startEp: selectedIdxs[0], endEp: selectedIdxs[selectedIdxs.length - 1],
        templates: [], girigiriEps: selectedEps, savePath,
        status: 'running', epStatus, epProgress: {}, startedAt: Date.now(),
      })
      setState({ status: 'queued' })
      setTimeout(onClose, 2000)
    } catch (err) { alert(`Download error: ${err}`) }
  }

  async function handleStartAowuDownload(sourceIdx: number, epList: AowuEpisode[], selectedIdxs: number[]): Promise<void> {
    if (state.status !== 'aowu_config') return
    const { card, watchInfo } = state
    const title = watchInfo.title || card.title
    const savePath = getSavePath()
    try {
      const { taskId } = await window.aowuApi.startDownload(title, watchInfo.id, sourceIdx, epList, selectedIdxs, savePath)
      const epStatus: Record<number, 'pending'> = {}
      for (const idx of selectedIdxs) epStatus[idx] = 'pending'
      downloadStore.addTask({
        id: taskId, source: 'aowu', title, cover: card.cover,
        startEp: selectedIdxs[0], endEp: selectedIdxs[selectedIdxs.length - 1],
        templates: [], sourceIdx,
        aowuId: watchInfo.id, aowuEps: epList,
        aowuSources: watchInfo.sources.map(s => ({ idx: s.idx, name: s.name })),
        savePath,
        status: 'running', epStatus, epProgress: {}, startedAt: Date.now(),
      })
      setState({ status: 'queued' })
      setTimeout(onClose, 2000)
    } catch (err) { alert(`Download error: ${err}`) }
  }

  // ── pickSource: 流程的第一道弹窗 — 让用户在搜索之前确认/切换源 ──────
  if (state.status === 'pickSource') {
    const picked = state.selected
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm">
        <div className="absolute inset-0" onClick={onClose} />
        <div className="relative bg-surface-container w-full max-w-md rounded-2xl border border-outline-variant/20 overflow-hidden shadow-2xl">
          <div className="p-6 border-b border-outline-variant/20 bg-surface-container-low flex justify-between items-center">
            <div>
              <h3 className="font-headline font-black text-lg text-on-surface">Choose Source</h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">
                "{initialKeyword}" — pick where to add from
              </p>
            </div>
            <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface transition-colors">
              <span className="material-symbols-outlined leading-none">close</span>
            </button>
          </div>
          <div className="p-6 space-y-2">
            {(['Aowu', 'Xifan', 'Girigiri'] as Source[]).map(opt => (
              <label
                key={opt}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  picked === opt
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-outline-variant/20 hover:bg-surface-container-high'
                }`}
              >
                <input
                  type="radio"
                  name="archive_pick_source"
                  value={opt}
                  checked={picked === opt}
                  onChange={() => setState({ status: 'pickSource', selected: opt })}
                  className="accent-primary"
                />
                <span className="font-label text-sm text-on-surface flex-1">{opt}</span>
                <span className="font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest">
                  {opt === 'Aowu' ? '无验证码' : '有验证码'}
                </span>
              </label>
            ))}
          </div>
          <div className="p-6 pt-0 flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-3 rounded-xl border border-outline-variant/20 font-label text-sm text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => confirmSource(picked)}
              className="flex-[2] py-3 rounded-xl bg-primary text-on-primary font-label text-sm font-bold tracking-widest hover:brightness-110 transition-all active:scale-95 flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-base leading-none">arrow_forward</span>
              Continue
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Configuring step delegates to source-specific shared modal (modal owns its
  // own overlay, so we render it standalone, not inside ArchiveFlow's overlay).
  if (state.status === 'xifan_config') {
    return (
      <XifanDownloadConfigModal
        card={state.card}
        watchInfo={state.watchInfo}
        onClose={onClose}
        onStart={(templates, startEp, endEp) => void handleStartXifanDownload(templates, startEp, endEp)}
      />
    )
  }
  if (state.status === 'girigiri_config') {
    return (
      <GirigiriDownloadConfigModal
        card={state.card}
        watchInfo={state.watchInfo}
        onClose={onClose}
        onStart={(eps) => void handleStartGirigiriDownload(eps)}
      />
    )
  }
  if (state.status === 'aowu_config') {
    return (
      <AowuDownloadConfigModal
        card={state.card}
        watchInfo={state.watchInfo}
        onClose={onClose}
        onStart={(sourceIdx, epList, selectedIdxs) => void handleStartAowuDownload(sourceIdx, epList, selectedIdxs)}
      />
    )
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
            {state.status === 'searching' ? `Searching ${source}...` : state.status === 'verifying' ? 'Verifying...' : 'Loading sources...'}
          </p>
        </div>
      )}

      {/* 验证码 */}
      {state.status === 'captcha' && (
        <div className="relative bg-surface-container w-full max-w-md rounded-2xl border border-outline-variant/20 overflow-hidden shadow-2xl">
          <div className="p-6 border-b border-outline-variant/20 bg-surface-container-low flex justify-between items-center">
            <div>
              <h3 className="font-headline font-black text-lg text-on-surface">Verification Required</h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">{state.captchaSource} requires captcha to search</p>
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
              <h3 className="font-headline font-black text-lg text-on-surface">Select from {source}</h3>
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
                key={card.key}
                onClick={() => void loadWatch(card)}
                className="w-full flex items-center justify-between bg-surface hover:bg-surface-container-high border border-outline-variant/10 hover:border-primary/20 rounded-xl px-5 py-4 text-left transition-all group"
              >
                <div className="min-w-0">
                  <p className="font-bold text-on-surface text-sm group-hover:text-primary transition-colors truncate">{card.title}</p>
                  <p className="font-label text-[10px] text-on-surface-variant/50 mt-0.5 uppercase tracking-widest">
                    {[card.year, card.count, card.tag].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/20 group-hover:text-primary/50 transition-colors text-lg shrink-0 ml-4">arrow_forward</span>
              </button>
            ))}
          </div>
        </div>
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

  // 别名：infobox 的「别名」字段 + 原名（若与显示标题不同）；去重
  const aliases = (() => {
    const raw = data.infobox?.['别名'] ?? ''
    const fromInfobox = raw.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
    const shown = (data.title_cn || data.title).trim()
    const origNative = data.title.trim()
    const merged: string[] = []
    if (origNative && origNative !== shown) merged.push(origNative)
    for (const a of fromInfobox) {
      if (a !== shown && !merged.includes(a)) merged.push(a)
    }
    return merged
  })()
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

          {/* 别名 */}
          {aliases.length > 0 && (
            <div className="mb-6 flex items-start gap-3">
              <span className="font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest pt-1 shrink-0">
                Also Known As
              </span>
              <div className="flex flex-wrap gap-x-2 gap-y-1">
                {aliases.map((a, i) => (
                  <span
                    key={`${a}-${i}`}
                    className="font-body text-sm text-on-surface-variant/70"
                  >
                    {a}
                    {i < aliases.length - 1 && (
                      <span className="text-on-surface-variant/20 ml-2">·</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Stats 行 */}
          <div className="flex gap-8 mb-12">
            <div>
              <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">
                Air Date
              </p>
              <p className="font-body font-bold text-on-surface whitespace-nowrap">
                {data.date || '—'}
              </p>
            </div>
            {(data.infobox?.['片长'] || data.infobox?.['时长']) && (
              <div>
                <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">
                  Duration
                </p>
                <p className="font-body font-bold text-on-surface whitespace-nowrap">
                  {data.infobox['片长'] || data.infobox['时长']}
                </p>
              </div>
            )}
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
let _cachedScrollY = 0

// ── 主页面 ────────────────────────────────────────────────────
function AnimeInfo(): JSX.Element {
  const [state, setState] = useState<PageState>(_cachedState)
  const lastResults = { current: _cachedResults }
  const lastBgmKeyword = useRef(_cachedBgmKeyword)
  const [archiveKeyword, setArchiveKeyword] = useState<string | null>(null)
  const pendingScrollRestore = useRef(false)

  useEffect(() => {
    _cachedState = state
  }, [state])

  // Restore scroll position after returning to results list
  useEffect(() => {
    if (state.status === 'results' && pendingScrollRestore.current) {
      pendingScrollRestore.current = false
      requestAnimationFrame(() => {
        const el = document.getElementById('page-scroll')
        if (el) el.scrollTop = _cachedScrollY
      })
    }
  }, [state.status])

  const sortByDate = (items: BgmSearchResult[]): BgmSearchResult[] => {
    items.sort((a, b) => {
      const da = /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : '0000-00-00'
      const db = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '0000-00-00'
      return db.localeCompare(da)
    })
    return items
  }

  const refreshBgmSearchInBackground = async (keyword: string): Promise<void> => {
    await dedupRefresh(`bgm:${keyword}`, async () => {
      try {
        const fresh = await window.bgmApi.search(keyword)
        if (!Array.isArray(fresh) || fresh.length === 0) return
        await setCachedBgmSearch(keyword, fresh)
      } catch {
        /* swallow — next foreground search will retry */
      }
    })
  }

  const handleSearch = async (keyword: string): Promise<void> => {
    lastBgmKeyword.current = keyword
    _cachedBgmKeyword = keyword
    const cacheEnabled = isSearchCacheEnabled()
    const hit = cacheEnabled ? await getCachedBgmSearch(keyword) : null

    if (hit) {
      const sorted = sortByDate(hit.data)
      if (sorted.length === 0) {
        setState({ status: 'error', message: `未找到与"${keyword}"相关的结果` })
      } else if (sorted.length === 1) {
        lastResults.current = []
        _cachedResults = []
        await loadDetail(sorted[0])
      } else {
        lastResults.current = sorted
        _cachedResults = sorted
        setState({ status: 'results', items: sorted })
      }
      if (hit.isStale) void refreshBgmSearchInBackground(keyword)
      return
    }

    setState({ status: 'searching' })
    try {
      const results = await window.bgmApi.search(keyword)
      if (cacheEnabled && results.length > 0) {
        void setCachedBgmSearch(keyword, results)
      }
      const sorted = sortByDate(results)
      if (sorted.length === 0) {
        setState({ status: 'error', message: `未找到与"${keyword}"相关的结果` })
      } else if (sorted.length === 1) {
        lastResults.current = []
        _cachedResults = []
        await loadDetail(sorted[0])
      } else {
        lastResults.current = sorted
        _cachedResults = sorted
        setState({ status: 'results', items: sorted })
      }
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    }
  }

  const loadDetail = async (item: BgmSearchResult): Promise<void> => {
    _cachedScrollY = document.getElementById('page-scroll')?.scrollTop ?? 0
    const sid = extractSubjectId(item.link)
    if (!sid) {
      setState({ status: 'error', message: 'Could not parse subject ID from link.' })
      return
    }
    setState({ status: 'loading' })
    try {
      const cacheEnabled = isSearchCacheEnabled()
      const cached = cacheEnabled ? await getCachedBgmDetail(sid) : null
      const detail = cached ?? (await window.bgmApi.detail(sid))
      if (cacheEnabled && !cached) {
        void setCachedBgmDetail(sid, detail)
      }
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
                ? () => {
                    pendingScrollRestore.current = true
                    setState({ status: 'results', items: lastResults.current })
                  }
                : undefined
            }
            onArchive={() => setArchiveKeyword(lastBgmKeyword.current || state.data.title_cn || state.data.title)}
          />
        )}
        {state.status === 'error' && (
          <ErrorPanel error={state.message} onRetry={() => setState({ status: 'idle' })} />
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
