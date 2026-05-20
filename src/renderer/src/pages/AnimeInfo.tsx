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
import { readCacheEntry, dedupRefresh, getSavePath, isSearchCacheEnabled } from '../utils/searchCache'
import { animeTrackStore, useAnimeTrack, deriveSubjectType } from '../stores/animeTrackStore'
import { useCover } from '../hooks/useCover'
import coverFallback from '../assets/cover-fallback.png'
import { WatchHere } from '../components/WatchHere'

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

// ── BGM 搜索结果缓存 ──────────────────────────────────────────
const BGM_SEARCH_CACHE_KEY = 'search_cache_bgm'

/** UI 上的"搜索类目" —— 跟 IPC 的 cat 数字对应：anime=2 / book=1 */
export type BgmSearchKind = 'anime' | 'book'

const KIND_TO_CAT: Record<BgmSearchKind, 1 | 2> = { anime: 2, book: 1 }

/**
 * 缓存里的复合 key —— 同一关键词在动画 / 书籍两种类目下命中的结果完全不同,
 * 缓存必须按 cat 分桶不能串味（比如「巨虫列岛」既是动画又是漫画）。
 *
 * 命名格式：`cat{N}:{keyword}`。老缓存数据没有前缀（直接用 keyword 当 key）,
 * 自动失效不复读 —— 老 key 仍留在 search_cache.json 里是无害的，下次搜
 * 同关键词时写一份新的带前缀的缓存条目，老条目自然作废。
 */
function bgmCacheKey(keyword: string, kind: BgmSearchKind): string {
  return `cat${KIND_TO_CAT[kind]}:${keyword}`
}

interface BgmSearchHit { data: BgmSearchResult[]; isStale: boolean }

async function getCachedBgmSearch(keyword: string, kind: BgmSearchKind): Promise<BgmSearchHit | null> {
  try {
    const c = (await window.systemApi.cacheGet(BGM_SEARCH_CACHE_KEY)) as Record<string, unknown> | null
    if (!c) return null
    const entry = readCacheEntry<BgmSearchResult[]>(c[bgmCacheKey(keyword, kind)])
    if (!entry) return null
    return { data: entry.data, isStale: Date.now() - entry.updatedAt > BGM_SEARCH_TTL_MS }
  } catch { return null }
}

async function setCachedBgmSearch(keyword: string, kind: BgmSearchKind, items: BgmSearchResult[]): Promise<void> {
  try {
    await window.systemApi.cacheSet(BGM_SEARCH_CACHE_KEY, bgmCacheKey(keyword, kind), {
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
        // AnimeInfo auto-selects when exactly 1 result lands, so we need the
        // *full* result set before deciding. Streaming search returns the
        // first page immediately and pumps subsequent pages via events; here
        // we synchronously wait for the stream to complete (done=true).
        const { requestId, results, more } = await window.aowuApi.search(kw)
        let cards = results.map(normalizeAowu)
        if (more) {
          await new Promise<void>((resolve) => {
            const unsub = window.aowuApi.onSearchPage((rid, page, done) => {
              if (rid !== requestId) return
              if (page.length > 0) cards = cards.concat(page.map(normalizeAowu))
              if (done) { unsub(); resolve() }
            })
          })
        }
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
        startEp, endEp, templates, sourceIdx: 0, savePath,
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
        girigiriEps: selectedEps, savePath,
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
        sourceIdx,
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
function LoadingSpinner({
  progress,
}: {
  /** When a multi-page BGM search is running, main fires progress events that
   * land here. Shows "page X / Y" below the spinner so the user has feedback
   * during ≥2s-per-page rate-limited fetches instead of staring at a blank
   * spinner for 10+ seconds. */
  progress?: { current: number; total: number } | null
} = {}): JSX.Element {
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
      {progress && progress.total > 1 && (
        <p className="font-label text-[11px] text-on-surface-variant/60 tracking-wider">
          Page {progress.current} / {progress.total}
        </p>
      )}
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

const KIND_OPTIONS: ReadonlyArray<{ key: BgmSearchKind; label: string }> = [
  { key: 'anime', label: '动画' },
  { key: 'book', label: '漫画小说' },
]

/**
 * BGM 搜索类目下拉 —— 嵌入到 TopBar 搜索框右侧（内切风格，仿 bgm.tv 自家
 * 顶栏的「全部/动画/书籍/…」下拉）。
 *
 * 设计意图：BGM 在 URL 层级把漫画+小说+画集合并成「书籍」类目，所以这里
 * 只暴露「动画 / 漫画小说」二选一。点击当前选项的胶囊弹出菜单，点选项关闭。
 * 外面 click 关闭走 useEffect mousedown 监听。
 *
 * 设计要点（修过两次的痛苦经验）：
 *   - **按钮固定宽度 w-24**：「动画」(2 字) 和「漫画小说」(4 字) 共用一个
 *     宽度，避免切换时按钮跳动 + 菜单宽度对不齐
 *   - **按钮 bg 明显区分搜索框**：搜索框是 `surface-container-highest`,
 *     按钮用 `surface-container-low` + border，看起来像"嵌入式胶囊"而不是
 *     裸文字
 *   - **菜单换暗色 + shadow**：菜单用 `surface-container-lowest`（比搜索框
 *     暗几档）+ shadow-xl 起浮感，跟搜索框拉开层次不再融在一起
 *   - **菜单跟按钮等宽 + left-0 对齐**：避免之前菜单宽于按钮、向左凸出来
 *     的视觉问题
 */
function KindDropdown({
  value, onChange,
}: {
  value: BgmSearchKind
  onChange: (k: BgmSearchKind) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const current = KIND_OPTIONS.find(o => o.key === value) ?? KIND_OPTIONS[0]

  return (
    // wrap div 在 TopBar 的 `items-stretch` 父容器下自动撑满分段高度;
    // 没设具体 height，靠 flex item 的默认拉伸。
    <div className="relative w-24 flex" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        // **rounded-r-md 不能丢** —— 容器没设 overflow-hidden（会吞下拉菜单),
        // 圆角必须按钮自己处理右上/右下两个角。
        //
        // 颜色挑选历史踩坑：
        //   - `surface-container-low`：太暗，跟页面背景（黑）几乎融在一起,
        //     反而跟输入区（surface-container-highest）差太大，像贴上去的
        //     暗块，**不能用**
        //   - `surface-container-high`：仅比输入区暗一档，**同色系族微差**,
        //     视觉上像同一个搜索框的两个分段，是最舒服的距离
        // hover/open 时切到 `surface-container-highest` 跟输入区平齐 ——
        // "唤醒"的视觉提示。
        className={`w-full flex items-center justify-between gap-1 px-3 text-xs font-label text-on-surface transition-colors outline-none rounded-r-md ${
          open
            ? 'bg-surface-container-highest'
            : 'bg-surface-container-high hover:bg-surface-container-highest'
        }`}
        title={value === 'anime' ? 'BGM 动画类目（cat=2）' : 'BGM 书籍类目，含漫画+小说（cat=1）'}
      >
        <span className="truncate">{current.label}</span>
        <span
          className={`material-symbols-outlined leading-none shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          style={{ fontSize: 14 }}
        >
          expand_more
        </span>
      </button>
      {open && (
        // 菜单跟搜索框同色系（surface-container-highest）—— 视觉上像是搜索框
        // 的延伸而不是另一个独立的暗色卡片。靠 shadow + border 而不是色差
        // 来表达"浮层"。参考 SearchDownload 的 source picker 同款配方。
        <div className="absolute top-full left-0 mt-1.5 w-full bg-surface-container-highest border border-outline-variant/30 rounded-md overflow-hidden shadow-xl shadow-black/40 z-50">
          {KIND_OPTIONS.map(o => (
            <button
              key={o.key}
              type="button"
              onClick={() => {
                onChange(o.key)
                setOpen(false)
              }}
              className={`w-full text-left px-3 py-2 text-xs font-label whitespace-nowrap transition-colors ${
                o.key === value
                  ? 'text-primary bg-primary/10 font-bold'
                  : 'text-on-surface hover:bg-surface-container-high'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
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
  const track = useAnimeTrack(data.id)
  const coverSrc = useCover(String(data.id), data.cover)

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
        <div className="col-span-4 sticky top-20">
          <div className="relative group mb-10">
            {/* 光晕 */}
            <div className="absolute -inset-4 bg-primary/5 rounded-xl blur-3xl opacity-0 group-hover:opacity-100 transition-opacity" />

            {/* 封面 —— useCover 解析本地路径；没封面 / 加载失败回落占位图。 */}
            <img
              src={coverSrc || coverFallback}
              alt={data.title_cn || data.title}
              className="relative rounded-lg shadow-2xl w-full aspect-[2/3] object-cover"
              onError={(e) => {
                const img = e.currentTarget
                if (img.src !== coverFallback) {
                  img.onerror = null
                  img.src = coverFallback
                }
              }}
            />

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
            {/* Tracking toggle — single button flipping between "add to list" and
                "remove from list". Status / episode / notes editing is intentionally
                kept off this page (it would sit below the fold in the sticky column)
                and will move to the aggregate "我的追番" view in a later step. */}
            {track ? (
              <button
                onClick={() => animeTrackStore.delete(data.id)}
                className="w-full py-4 rounded-full bg-primary-container/15 border border-primary-container/30 hover:bg-error-container/15 hover:border-error/30 text-primary hover:text-error transition-colors flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-lg leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>bookmark</span>
                <span className="font-label text-sm">已加入追番</span>
              </button>
            ) : (
              <button
                onClick={() => {
                  animeTrackStore.upsert({
                    bgmId: data.id,
                    // 005 阶段新增：从 BGM detail 的 type + platform 派生 subjectType,
                    // 写入 track。书籍类目下 platform 决定 manga / novel；画集和其他
                    // 归 'other'（用户决策见 005 idea doc，UI tab 不显示 other）。
                    subjectType: deriveSubjectType(data.type, data.platform),
                    title: data.title,
                    titleCn: data.title_cn || undefined,
                    cover: data.cover || undefined,
                    totalEpisodes: data.episodes > 0 ? data.episodes : undefined,
                    status: 'plan',
                    episode: 0,
                    // 加追番那一刻把 BGM 当前 tag 快照写入 —— store 内 lock-on-create
                    // 保证之后再 fetch detail 即使 tag 变了，本地这份不动。删追番
                    // 再重加 = 重新拍快照（store 看到 prev 不存在就会接受新值）。
                    bgmTags: data.tags,
                  })
                  // 封面本地化不在这做 —— track.cover 存可移植 URL，本地化
                  // 在显示时由 useCover 按设备各自处理（见 hooks/useCover.ts）。
                }}
                className="w-full py-4 rounded-full bg-surface-container hover:bg-surface-container-high border border-outline-variant/15 hover:border-primary/30 text-on-surface-variant hover:text-primary font-label text-sm transition-colors flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-lg leading-none">bookmark_add</span>
                Track this anime
              </button>
            )}
            {/* 已关联的源跳转 — 只在 bindings 非空时出现，每个源一颗 chip。
                未追番时 useAnimeTrack 返回 null，组件自身就 return null，
                所以这里不需要包条件分支。 */}
            <WatchHere bgmId={data.id} variant="row" />
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
                  {/* detail.ts 已经 slice(0, 4) 了，这里直接 join 即可；
                      数量上限跟 MyAnime 的 UserTagsEditor "BGM 标签" 区一致。 */}
                  {data.tags.join(' · ')}
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
let _cachedSearchKind: BgmSearchKind = 'anime'
let _cachedScrollY = 0

// ── 主页面 ────────────────────────────────────────────────────
function AnimeInfo(): JSX.Element {
  const [state, setState] = useState<PageState>(_cachedState)
  const lastResults = { current: _cachedResults }
  const lastBgmKeyword = useRef(_cachedBgmKeyword)
  const [archiveKeyword, setArchiveKeyword] = useState<string | null>(null)
  const pendingScrollRestore = useRef(false)
  // Live progress from main-process BGM search. Set by the IPC subscription
  // below; cleared at the start/end of every search invocation.
  const [searchProgress, setSearchProgress] = useState<{ current: number; total: number } | null>(null)
  // 用户选的搜索类目（动画 vs 书籍）。模块级缓存让用户切到别的页面再回来
  // 不丢类目选择。切类目时清空当前 results —— 类目变了，旧动画结果显示
  // 在新书籍搜索栏下面会很怪。
  const [searchKind, setSearchKindState] = useState<BgmSearchKind>(_cachedSearchKind)
  const setSearchKind = (k: BgmSearchKind): void => {
    if (k === searchKind) return
    _cachedSearchKind = k
    setSearchKindState(k)
    // 切类目时把当前结果列表清掉，避免"我刚搜了动画看到结果，切到书籍
    // 后还看着动画卡片"的视觉混乱
    lastResults.current = []
    _cachedResults = []
    setState({ status: 'idle' })
  }

  useEffect(() => {
    _cachedState = state
  }, [state])

  // Subscribe once for the page lifetime. Main process emits a `(current, total)`
  // tuple after each page completes (cache hit or rate-limited network fetch).
  useEffect(() => {
    const unsub = window.bgmApi.onSearchProgress((current, total) => {
      setSearchProgress({ current, total })
    })
    return unsub
  }, [])

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

  /**
   * Stale-cache background refresh：用户已经看到旧数据了，我们后台**单次**
   * 请求新数据更新缓存（下次搜索就能看到新的）。`update=true` 让主进程也
   * 跳过磁盘缓存，否则就只是重新缓存同一份旧 HTML。
   *
   * **失败处理**：catch 后**直接 swallow**，不重试。如果 BGM 限流了：
   *   - 本次后台刷新作废 → 缓存仍是 stale
   *   - 用户下次搜同一关键词 → SWR 再触发一次
   *   - 如果还限流 → 继续作废 → 一直等到 BGM 放行
   * 这套语义符合 docs/bgm-集成参考手册.md §3 的「失败后不试探不重试」原则。
   */
  const refreshBgmSearchInBackground = async (keyword: string, kind: BgmSearchKind): Promise<void> => {
    // dedupRefresh key 也按 kind 分桶 —— 同一关键词的动画 SWR 和书籍 SWR
    // 并发时是不同的两个请求，不能复用 inflight Promise
    await dedupRefresh(`bgm:${kind}:${keyword}`, async () => {
      try {
        const fresh = await window.bgmApi.search(keyword, true, KIND_TO_CAT[kind])
        if (!Array.isArray(fresh) || fresh.length === 0) return
        await setCachedBgmSearch(keyword, kind, fresh)
      } catch {
        /* swallow — 失败不重试，等下次用户主动搜索触发新一轮 SWR */
      }
    })
  }

  /**
   * Search semantics (matches SearchDownload / per project-wide setting):
   *   - Cache ON  + hit + fresh  → use cache, return early
   *   - Cache ON  + hit + stale  → use cache for display, refresh in background (SWR)
   *   - Cache ON  + miss         → fetch online (main may still use its disk cache)
   *   - Cache OFF                → always fetch online with update=true, bypassing
   *                                BOTH renderer and main-side caches
   *
   * After ANY successful fetch the renderer cache is updated (data + timestamp),
   * regardless of the setting — so when the user flips it back on the cache is
   * already populated and the TTL clock is restarted.
   */
  const handleSearch = async (keyword: string): Promise<void> => {
    lastBgmKeyword.current = keyword
    _cachedBgmKeyword = keyword
    const cacheEnabled = isSearchCacheEnabled()
    // 用本地变量锁定本次搜索的类目，避免用户在请求飞行中切换类目导致
    // setState 把书籍结果塞进动画状态里
    const kind = searchKind

    if (cacheEnabled) {
      const hit = await getCachedBgmSearch(keyword, kind)
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
        if (hit.isStale) void refreshBgmSearchInBackground(keyword, kind)
        return
      }
    }

    setSearchProgress(null)
    setState({ status: 'searching' })
    try {
      // When the cache toggle is OFF the user has explicitly asked for fresh
      // data, so we bypass main's disk cache too. When ON we allow main to
      // serve from disk (it's faster and avoids any chance of rate-limiting).
      const results = await window.bgmApi.search(keyword, !cacheEnabled, KIND_TO_CAT[kind])
      if (results.length > 0) {
        // Always write through, even when cache is OFF — per user contract:
        // "关闭的时候同时更新缓存里的数据以及 ttl 这些时间"
        void setCachedBgmSearch(keyword, kind, results)
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
    } finally {
      setSearchProgress(null)
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
      <TopBar
        placeholder="Lookup titles from bgm.tv..."
        onSearch={handleSearch}
        // 类目下拉嵌在搜索框右侧内切位置（仿 bgm.tv 顶栏自家的"全部/动画/
        // 书籍"下拉）。detail 视图也保留显示，用户切类目=回到搜索流程。
        searchRightSlot={<KindDropdown value={searchKind} onChange={setSearchKind} />}
      />

      <main className="ml-0 pt-16 px-10 py-10">
        {state.status === 'idle' && <IdleState />}
        {(state.status === 'searching' || state.status === 'loading') && (
          <LoadingSpinner progress={state.status === 'searching' ? searchProgress : null} />
        )}
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
