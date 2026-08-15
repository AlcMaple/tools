import { useState, useEffect, useRef } from 'react'
import TopBar from '../components/TopBar'
import ErrorPanel from '../components/ErrorPanel'
import { friendlyError } from '../utils/errorMessage'
import type { BgmSearchResult, BgmDetail } from '../types/bgm'
import type { XifanWatchInfo } from '../types/xifan'
import type { GirigiriEpisode, GirigiriWatchInfo } from '../types/girigiri'
import type { AowuEpisode, AowuWatchInfo } from '../types/aowu'
import type { Source, SearchCard } from '../types/search'
import { normalizeXifan, normalizeGirigiri, normalizeAowu } from '../utils/searchNormalize'
import { XifanDownloadConfigModal } from '../components/XifanDownloadModal'
import { GirigiriDownloadConfigModal } from '../components/GirigiriDownloadModal'
import { AowuDownloadConfigModal } from '../components/AowuDownloadModal'
import { BgmLoginChip } from '../components/BgmLoginChip'
import { downloadStore } from '../stores/downloadStore'
import { readCacheEntry, getSavePath, isSearchCacheEnabled, setCachedSearch } from '../utils/searchCache'
import { animeTrackStore, useAnimeTrack, deriveSubjectType, aliasesFromInfobox } from '../stores/animeTrackStore'
import { loadBgmHistory, addBgmHistory, removeBgmHistory, clearBgmHistory } from '../utils/bgmSearchHistory'
import { useCover } from '../hooks/useCover'
import { weekdayFromAirDate } from '../utils/airDate'
import coverFallback from '../assets/cover-fallback.png'

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
  // 同时写一份 SearchDownload 的共享缓存,让两边联动 —— 否则在详情页搜过某源后
  // 去搜索下载搜同一标题读不到缓存,又要重新过一次验证码。
  void setCachedSearch(keyword, source, cards)
}

/** UI 上的"搜索类目" —— 跟 IPC 的 cat 数字对应：anime=2 / book=1 */
export type BgmSearchKind = 'anime' | 'book'

const KIND_TO_CAT: Record<BgmSearchKind, 1 | 2> = { anime: 2, book: 1 }

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
        // 只有 1 个结果时页面会自动选中,所以必须拿到**完整**结果集再判断。流式搜索会先回
        // 第一页、后续页走事件,这里同步等到 done=true。
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
    // **即使只命中 1 个结果也要列出来让用户确认** —— 源搜索用的是关键词而不是 BGM 详情标题
    // 单个结果未必就是用户在看的这部番,直接进选集会下错番。
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
        // watch() 只解析当前激活线路(播放器按需惰性解析,省请求);下载配置面板要一次性列出
        // 全部线路,所以这里并发补齐其余线路的 template。
        const sources = await window.xifanApi.resolveAllSources(watchInfo.id, watchInfo.sources)
        setState({ status: 'xifan_config', card, watchInfo: { ...watchInfo, sources } })
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

  async function handleStartXifanDownload(templates: string[], epPages: string[], startEp: number, endEp: number, excluded: number[]): Promise<void> {
    if (state.status !== 'xifan_config') return
    const { card, watchInfo } = state
    const title = watchInfo.title || card.title
    const savePath = getSavePath()
    const skip = new Set(excluded)
    try {
      const { taskId } = await window.xifanApi.startDownload(title, templates, startEp, endEp, savePath, excluded, epPages)
      const epStatus: Record<number, 'pending'> = {}
      for (let ep = startEp; ep <= endEp; ep++) if (!skip.has(ep)) epStatus[ep] = 'pending'
      downloadStore.addTask({
        id: taskId, source: 'xifan', title, cover: card.cover,
        startEp, endEp, templates, epPages, epUrls: {}, sourceIdx: 0, savePath,
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

  // configuring 步骤交给各源自己的弹窗(弹窗自带遮罩,所以独立渲染,不套在本组件的遮罩里)。
  if (state.status === 'xifan_config') {
    return (
      <XifanDownloadConfigModal
        card={state.card}
        watchInfo={state.watchInfo}
        onClose={onClose}
        onStart={(templates, epPages, startEp, endEp, excluded) => void handleStartXifanDownload(templates, epPages, startEp, endEp, excluded)}
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
          <div className="custom-scrollbar overflow-y-auto flex-1 p-4 space-y-2">
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
            {/* 这个 error 状态既装真异常（connect ETIMEDOUT 等看不懂的原始串）也装
                友好提示（「未找到」「返回了意外的响应」）。前者过 friendlyError 翻成
                人话；后者 friendlyError 命不中（title 仍是兜底「出错了」），直接显示原文。 */}
            {(() => {
              const fe = friendlyError(state.message)
              const classified = fe.title !== '出错了'
              return (
                <>
                  <p className="font-label text-xs text-error uppercase tracking-[0.2em] mb-2">
                    {classified ? fe.title : 'Failed'}
                  </p>
                  <p className="font-body text-sm text-on-surface-variant leading-relaxed">
                    {classified ? fe.hint : state.message}
                  </p>
                </>
              )
            })()}
          </div>
          <div className="w-full">
            <input
              type="text"
              value={searchKeyword}
              onChange={e => setSearchKeyword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && searchKeyword.trim()) void doSearch(searchKeyword.trim(), true) }}
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
  | { status: 'searching'; mode: 'offline' | 'online' }
  | {
      status: 'results'
      items: BgmSearchResult[]
      mode: 'offline' | 'online'
      keyword: string
      kind: BgmSearchKind
    }
  | {
      status: 'empty'
      mode: 'offline' | 'online'
      keyword: string
      kind: BgmSearchKind
      message: string
    }
  | { status: 'loading' }
  | { status: 'detail'; data: BgmDetail }
  | {
      status: 'error'
      message: string
      mode?: 'offline' | 'online'
      keyword?: string
      kind?: BgmSearchKind
    }

// ── 子组件 ────────────────────────────────────────────────────
function LoadingSpinner({
  progress,
  label = 'Loading...',
}: {
  /**
   * 多页 BGM 搜索时主进程发来的进度,显示成「第 X / Y 页」——每页要等 ≥2s 的限速
   * 没有这个反馈用户会对着空转的 spinner 干瞪十几秒。
   */
  progress?: { current: number; total: number } | null
  label?: string
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
        {label}
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
 * BGM 搜索类目下拉,内切在 TopBar 搜索框右侧(仿 bgm.tv 自家顶栏)。BGM 在 URL 层级把
 * 漫画+小说+画集合并成「书籍」,所以这里只有「动画 / 漫画小说」二选一。
 *
 * 两点样式约束(踩过两次):按钮**固定宽度**,否则「动画」和「漫画小说」切换时按钮会跳;
 * 菜单与按钮等宽且 left-0 对齐,否则菜单会比按钮宽、向左凸出来。
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
        // **rounded-r-md 不能丢** —— 容器不能设 overflow-hidden(会吞掉下拉菜单),右侧圆角只能
        // 按钮自己处理。配色定在比输入区暗一档的同色系:再暗就跟页面背景融在一起、反而像贴上去的
        // 暗块。hover/open 时与输入区平齐,作为「唤醒」提示。
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
        // 菜单与搜索框同色系,靠 shadow + border 而不是色差来表达浮层 —— 视觉上像搜索框的延伸
        // 而不是另一张独立的暗色卡片。
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
  mode,
  onOnlineSearch,
  onSelect,
}: {
  items: BgmSearchResult[]
  mode: 'offline' | 'online'
  onOnlineSearch?: () => void
  onSelect: (item: BgmSearchResult) => void
}): JSX.Element {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40">
          {items.length} result{items.length !== 1 ? 's' : ''} found · {mode === 'offline' ? '本地结果' : '在线结果'}
        </p>
        {mode === 'offline' && onOnlineSearch && (
          <button
            type="button"
            onClick={onOnlineSearch}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-outline-variant/25 bg-surface-container text-on-surface-variant hover:text-primary hover:border-primary/35 transition-colors font-label text-xs"
          >
            <span className="material-symbols-outlined text-base leading-none">language</span>
            在线搜索
          </button>
        )}
      </div>
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

function EmptySearchState({
  message,
  mode,
  onOnlineSearch,
}: {
  message: string
  mode: 'offline' | 'online'
  onOnlineSearch?: () => void
}): JSX.Element {
  return (
    <div className="max-w-3xl mx-auto flex flex-col items-center justify-center py-32 gap-5 text-center">
      <span className="material-symbols-outlined text-on-surface-variant/35 text-5xl">search_off</span>
      <div>
        <p className="font-headline text-base font-bold text-on-surface">{message}</p>
        <p className="font-label text-[11px] text-on-surface-variant/45 mt-2">
          {mode === 'offline' ? '可调整关键词，或继续在线搜索' : '可以换个关键词再试'}
        </p>
      </div>
      {mode === 'offline' && onOnlineSearch && (
        <button
          type="button"
          onClick={onOnlineSearch}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-primary/35 bg-primary/10 text-primary hover:bg-primary/15 transition-colors font-label text-sm font-bold"
        >
          <span className="material-symbols-outlined text-lg leading-none">language</span>
          在线搜索
        </button>
      )}
    </div>
  )
}

function DetailView({
  data,
  onArchive,
}: {
  data: BgmDetail
  onArchive?: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const hasStaff = data.staff.length > 0
  const displayTitle = (data.title_cn || data.title).toUpperCase()
  const track = useAnimeTrack(data.id)
  // 详情页大封面显示到 ~340px，用 600px 缓存（列表/周历的 480 在这里会糊）。
  const coverSrc = useCover(String(data.id), data.cover, 600)

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

  // ── 手机/平板分支复用的小块（桌面分支不引用这些，保持原样不受影响） ──
  const addTrack = (): void => {
    animeTrackStore.upsert({
      bgmId: data.id,
      subjectType: deriveSubjectType(data.type, data.platform),
      title: data.title,
      titleCn: data.title_cn || undefined,
      aliases: aliasesFromInfobox(data.infobox),
      cover: data.cover || undefined,
      totalEpisodes: data.episodes > 0 ? data.episodes : undefined,
      // 放送日期('' = BGM 无日期 = 未定档,播放按钮据此隐藏,见 utils/airDate.ts)
      airDate: data.date,
      airWeekday: weekdayFromAirDate(data.date) || undefined,
      status: 'plan',
      episode: 0,
      bgmTags: data.tags,
    })
  }
  const removeTrack = (): void => {
    animeTrackStore.delete(data.id)
  }

  const titleContent = (
    <>
      {restTitle && <>{restTitle} </>}
      <span className="text-primary">{lastWord}</span>
    </>
  )
  const duration = data.infobox?.['片长'] || data.infobox?.['时长'] || ''
  // Hero 右栏的元信息字段（评分不在这里 —— 它压在封面右下角的浮层里）
  const metaFields: { label: string; value: string; wide?: boolean }[] = [
    { label: 'Air Date', value: data.date || '—' },
    ...(duration ? [{ label: 'Duration', value: duration }] : []),
    ...(data.studio ? [{ label: 'Studio', value: data.studio }] : []),
    ...(data.tags.length > 0
      ? // detail.ts 已经 slice(0, 4)，这里直接 join
        [{ label: 'Genre', value: data.tags.join(' · '), wide: true }]
      : []),
  ]

  return (
    <div className="max-w-5xl mx-auto">
      {/* ── Hero：单一结构通吃手机/平板/桌面（原来手机 / 平板 / 桌面三套分支合并）──
          - md 以上：左封面 + 右信息，按钮 mt-auto 顶到右栏底部，与封面下沿齐平；
            右栏比封面矮时中间空白被吃掉，比封面高时按钮自然跟在文本后面。
          - md 以下：封面 float-left，标题/别名绕着它排（堆叠居中会让封面左右两侧
            全空、图片过分抢戏），按钮 clear-left 后通栏。
          - 元信息在手机端刻意不用 grid/flex：它们会建立独立格式化上下文、整块被挤到
            封面下方，导致封面右下角空一片；inline-block 行内块才会真正绕排。 */}
      <div className="md:flex md:flex-row md:gap-6 lg:gap-10 md:items-stretch pb-8 border-b border-outline-variant/10">
        {/* 封面 + 评分浮层（浮层压在图内，不再 -bottom/-right 外溢撑出横向滚动） */}
        <div className="float-left mr-5 w-[38%] max-w-[150px] md:float-none md:mr-0 md:w-[200px] md:max-w-none lg:w-[260px] md:shrink-0">
          <div className="relative">
            <img
              src={coverSrc || coverFallback}
              alt={data.title_cn || data.title}
              className="w-full aspect-[2/3] object-cover rounded-xl shadow-2xl"
              decoding="async"
              onError={(e) => {
                const img = e.currentTarget
                if (img.src !== coverFallback) {
                  img.onerror = null
                  img.src = coverFallback
                }
              }}
            />
            <div className="absolute bottom-2 right-2 md:bottom-3 md:right-3 bg-surface-variant/70 backdrop-blur-2xl px-2.5 py-1.5 md:px-4 md:py-3 rounded-lg md:rounded-xl border border-outline-variant/15 shadow-2xl">
              <p className="hidden md:block font-label text-[9px] uppercase tracking-widest text-primary mb-0.5">
                Bangumi Rating
              </p>
              <div className="flex items-baseline gap-1">
                <span className="text-xl md:text-3xl font-black text-on-surface tracking-tighter">
                  {data.score > 0 ? data.score.toFixed(1) : '--'}
                </span>
                <span className="text-on-surface-variant font-label text-[10px] md:text-xs">/ 10</span>
              </div>
            </div>
          </div>
        </div>

        {/* 右栏：类型徽章 + 标题 + 别名 + 元信息 + 底部按钮 */}
        <div className="md:flex-1 md:min-w-0 md:w-full md:flex md:flex-col">
          <div className="flex items-center gap-3 mb-3">
            <span className="px-3 py-1 bg-secondary-container text-on-secondary-container font-label text-[10px] tracking-widest uppercase rounded-sm shrink-0">
              {data.platform || 'TV'}
            </span>
            <span className="text-on-surface-variant font-label text-xs md:text-sm truncate">
              {data.episodes > 0 ? `${data.episodes} Episodes` : ''}
              {data.tags.length > 0 && data.episodes > 0 ? ' · ' : ''}
              {data.tags.slice(0, 2).join(' · ')}
            </span>
          </div>

          {/* 流体字号：窄屏是整体缩小而不是疯狂换行把右栏顶高，两栏高度才对得上 */}
          <h2
            className="font-black text-on-surface tracking-tighter leading-[0.95] mb-4"
            style={{ fontSize: 'clamp(1.5rem, 4.2vw, 3.75rem)' }}
          >
            {titleContent}
          </h2>

          {aliases.length > 0 && (
            <div className="mb-5 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
              <span className="font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest sm:pt-1 shrink-0">
                Also Known As
              </span>
              <p className="font-body text-[13px] leading-relaxed text-on-surface-variant/70">
                {aliases.join(' · ')}
              </p>
            </div>
          )}

          <div className="md:grid md:grid-cols-2 lg:grid-cols-3 md:gap-x-6 md:gap-y-4">
            {metaFields.map((m) => (
              <div
                key={m.label}
                className={`inline-block align-top mr-8 mb-4 md:block md:mr-0 md:mb-0 ${
                  m.wide ? 'md:col-span-2 lg:col-span-1' : ''
                }`}
              >
                <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">
                  {m.label}
                </p>
                <p className="font-body font-bold text-on-surface text-sm md:text-base">{m.value}</p>
              </div>
            ))}
          </div>

          {/* 操作按钮：md 以上 mt-auto 顶到底部与封面对齐；sm 以下退化成竖排通栏 */}
          <div className="clear-left md:clear-none mt-6 md:mt-auto md:pt-7 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button
              onClick={onArchive}
              className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-b from-primary to-primary-container text-on-primary font-bold text-sm tracking-tight flex items-center justify-center gap-2 shadow-lg shadow-primary/20 active:scale-95 transition-transform hover:brightness-110"
            >
              <span className="material-symbols-outlined text-lg leading-none">download</span>
              <span className="truncate">加入媒体库</span>
            </button>
            <button
              onClick={() => window.open(data.link, '_blank')}
              className="w-full py-3.5 px-4 rounded-2xl bg-secondary-container/30 hover:bg-secondary-container/50 border border-secondary/20 transition-colors font-label text-sm text-on-secondary-container flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg leading-none">public</span>
              <span className="truncate">Official Site</span>
            </button>
            {track ? (
              <button
                onClick={removeTrack}
                className="w-full py-3.5 px-4 rounded-2xl bg-primary-container/15 hover:bg-primary-container/25 border border-primary-container/30 text-primary transition-colors flex items-center justify-center gap-2"
              >
                <span
                  className="material-symbols-outlined text-lg leading-none"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  bookmark
                </span>
                <span className="font-label text-sm truncate">已加入追番</span>
              </button>
            ) : (
              <button
                onClick={addTrack}
                className="w-full py-3.5 px-4 rounded-2xl bg-surface-container hover:bg-surface-container-high border border-outline-variant/15 hover:border-primary/30 text-on-surface-variant hover:text-primary transition-colors flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-lg leading-none">bookmark_add</span>
                <span className="font-label text-sm truncate">追番</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── 通栏简介：不再挤在窄列里，长内容只是卡片变高 ── */}
      <div className="bg-surface-container rounded-xl p-5 md:p-8 lg:p-10 my-8 lg:my-10">
        <h3 className="font-label text-[10px] md:text-xs text-primary uppercase tracking-[0.2em] mb-3 md:mb-4">
          The Narrative
        </h3>
        <p className="text-on-surface-variant leading-relaxed text-[13.5px] md:text-base lg:text-lg font-light">
          {data.summary || 'No summary available for this entry.'}
        </p>
      </div>

      {/* ── 通栏 Staff：2/3/4 列响应式网格，人多就只是往下多几行 ── */}
      {hasStaff ? (
        <div>
          <h3 className="text-[10px] font-label text-on-surface-variant/40 tracking-widest uppercase mb-4 flex items-center gap-3">
            Staff
            <span className="h-px flex-1 bg-outline-variant/10" />
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {data.staff.map((s) => (
              <div
                key={s.role}
                className="flex items-center gap-3 bg-surface-container p-3 md:p-4 rounded-xl border border-outline-variant/20"
              >
                <div className="w-9 h-9 md:w-10 md:h-10 rounded-full bg-surface-container-high flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-on-surface-variant/30 text-base leading-none">
                    {getIcon(s.role)}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-label text-on-surface-variant/40 uppercase tracking-widest">
                    {s.role}
                  </p>
                  <p className="text-sm font-bold text-on-surface truncate">{s.name_cn || s.name}</p>
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
            <p className="font-body text-xs italic">Staff metadata is not included in this record.</p>
          </div>
        </div>
      )}

      {/* ── 底部 Metadata Strip ── */}
      <div className="mt-12 lg:mt-20 pt-8 border-t border-outline-variant/10 flex flex-col gap-5 md:flex-row md:justify-between md:items-center">
        <div className="flex flex-wrap gap-6 md:gap-12">
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
let _cachedResultState: Extract<PageState, { status: 'results' }> | null = null
let _cachedBgmKeyword = ''
let _cachedSearchKind: BgmSearchKind = 'anime'
let _cachedScrollY = 0

// ── 主页面 ────────────────────────────────────────────────────
function AnimeInfo(): JSX.Element {
  const [state, setState] = useState<PageState>(() =>
    _cachedState.status === 'searching' || _cachedState.status === 'loading'
      ? (_cachedResultState ?? { status: 'idle' })
      : _cachedState,
  )
  const lastResultState = useRef(_cachedResultState)
  const lastBgmKeyword = useRef(_cachedBgmKeyword)
  const [archiveKeyword, setArchiveKeyword] = useState<string | null>(null)
  const pendingScrollRestore = useRef(false)
  const requestIdRef = useRef(0)
  // 显式在线搜索的互斥锁，同时控制分页进度接收。在 Promise settle 前，顶栏 Enter、
  // 历史记录和其他在线入口都只能返回，不能再发第二个搜索请求。
  const onlineSearchActiveRef = useRef(false)
  const [searchProgress, setSearchProgress] = useState<{ current: number; total: number } | null>(null)
  // 用户选的搜索类目。模块级缓存让切走再回来不丢选择。
  const [searchKind, setSearchKindState] = useState<BgmSearchKind>(_cachedSearchKind)
  // 搜索历史（本地，不跨设备）。每条带 kind，点选时连类目一起恢复。
  const [history, setHistory] = useState(() => loadBgmHistory())
  const setSearchKind = (k: BgmSearchKind): void => {
    if (k === searchKind) return
    _cachedSearchKind = k
    setSearchKindState(k)
    // 切类目只改「下次搜索用哪个 cat」,**不动当前已显示的结果** —— 用户要求切换保持原样
    // 等真正再点搜索时才按新类目取内容。
  }

  useEffect(() => {
    _cachedState = state
  }, [state])

  // 整页生命周期只订阅一次。离线查询不显示也不接收在线分页进度。
  useEffect(() => {
    const unsub = window.bgmApi.onSearchProgress((current, total) => {
      if (onlineSearchActiveRef.current) setSearchProgress({ current, total })
    })
    return () => {
      onlineSearchActiveRef.current = false
      requestIdRef.current += 1
      unsub()
    }
  }, [])

  // 回到结果列表时恢复滚动位置
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
    return [...items].sort((a, b) => {
      const da = /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : '0000-00-00'
      const db = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '0000-00-00'
      return db.localeCompare(da)
    })
  }

  const showResults = (
    items: BgmSearchResult[],
    mode: 'offline' | 'online',
    keyword: string,
    kind: BgmSearchKind,
  ): void => {
    const next: Extract<PageState, { status: 'results' }> = {
      status: 'results', items, mode, keyword, kind,
    }
    lastResultState.current = next
    _cachedResultState = next
    setState(next)
  }

  const rememberSearch = (keyword: string, kind: BgmSearchKind): void => {
    lastBgmKeyword.current = keyword
    _cachedBgmKeyword = keyword
    setHistory(addBgmHistory(keyword, kind))
  }

  // 默认搜索只读本地索引。无结果、索引未就绪或类目不支持时都停在当前页，绝不自动联网。
  const handleOfflineSearch = async (rawKeyword: string, kindOverride?: BgmSearchKind): Promise<void> => {
    if (onlineSearchActiveRef.current) return
    const keyword = rawKeyword.trim()
    if (!keyword) return
    const kind = kindOverride ?? searchKind
    rememberSearch(keyword, kind)
    const myId = ++requestIdRef.current
    onlineSearchActiveRef.current = false
    setSearchProgress(null)
    setState({ status: 'searching', mode: 'offline' })
    try {
      const result = await window.bgmApi.searchOffline(keyword, KIND_TO_CAT[kind])
      if (myId !== requestIdRef.current) return
      if (!result.supported) {
        setState({
          status: 'empty', mode: 'offline', keyword, kind,
          message: kind === 'book' ? '漫画小说请使用在线搜索' : '当前类目请使用在线搜索',
        })
      } else if (!result.ready) {
        setState({
          status: 'empty', mode: 'offline', keyword, kind,
          message: '本地数据正在准备',
        })
      } else if (!Array.isArray(result.items) || result.items.length === 0) {
        setState({
          status: 'empty', mode: 'offline', keyword, kind,
          message: `离线库未找到与“${keyword}”相关的结果`,
        })
      } else {
        // 本地索引已经按相关度排序；不要再按日期打乱。
        showResults(result.items, 'offline', keyword, kind)
      }
    } catch (err) {
      if (myId !== requestIdRef.current) return
      setState({ status: 'error', message: String(err), mode: 'offline', keyword, kind })
    }
  }

  // 只有这个显式入口会访问 BGM；update=true 跳过旧在线缓存，交给现有限速与风控逻辑处理。
  const handleOnlineSearch = async (rawKeyword: string, kind: BgmSearchKind): Promise<void> => {
    if (onlineSearchActiveRef.current) return
    const keyword = rawKeyword.trim()
    if (!keyword) return
    rememberSearch(keyword, kind)
    const myId = ++requestIdRef.current
    onlineSearchActiveRef.current = true
    setSearchProgress(null)
    setState({ status: 'searching', mode: 'online' })
    try {
      const results = await window.bgmApi.searchOnline(keyword, true, KIND_TO_CAT[kind])
      if (myId !== requestIdRef.current) return
      const sorted = sortByDate(Array.isArray(results) ? results : [])
      if (sorted.length === 0) {
        setState({
          status: 'empty', mode: 'online', keyword, kind,
          message: `BGM 在线搜索未找到与“${keyword}”相关的结果`,
        })
      } else {
        showResults(sorted, 'online', keyword, kind)
      }
    } catch (err) {
      if (myId !== requestIdRef.current) return
      setState({ status: 'error', message: String(err), mode: 'online', keyword, kind })
    } finally {
      if (myId === requestIdRef.current) {
        onlineSearchActiveRef.current = false
        setSearchProgress(null)
      }
    }
  }

  const loadDetail = async (item: BgmSearchResult): Promise<void> => {
    const myId = ++requestIdRef.current
    onlineSearchActiveRef.current = false
    setSearchProgress(null)
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
      if (myId !== requestIdRef.current) return
      if (cacheEnabled && !cached) {
        void setCachedBgmDetail(sid, detail)
      }
      setState({ status: 'detail', data: detail })
    } catch (err) {
      if (myId !== requestIdRef.current) return
      setState({ status: 'error', message: String(err) })
    }
  }

  const onlineSearching = state.status === 'searching' && state.mode === 'online'

  return (
    <div className="min-h-screen bg-background">
      <TopBar
        placeholder="搜索动画或漫画小说…"
        onSearch={onlineSearching ? undefined : (kw) => void handleOfflineSearch(kw)}
        // 类目下拉嵌在搜索框右侧内切位置（仿 bgm.tv 顶栏自家的"全部/动画/
        // 书籍"下拉）。detail 视图也保留显示，用户切类目=回到搜索流程。
        searchRightSlot={<KindDropdown value={searchKind} onChange={setSearchKind} />}
        // 历史下拉：点一条 → 恢复当时的类目 + 直接重搜（带 kind override，
        // 不等 setSearchKind 异步生效）。
        searchHistory={history.map((e) => ({
          keyword: e.keyword,
          meta: e.kind === 'anime' ? '动画' : '漫画小说',
        }))}
        onPickHistory={onlineSearching ? undefined : (i) => {
          const e = history[i]
          if (!e) return
          setSearchKind(e.kind)
          void handleOfflineSearch(e.keyword, e.kind)
        }}
        onRemoveHistory={(i) => {
          const e = history[i]
          if (e) setHistory(removeBgmHistory(e.keyword, e.kind))
        }}
        onClearHistory={() => setHistory(clearBgmHistory())}
      />

      {/* pt-16 = 64px 让出 fixed 顶栏高度。顶部内边距只能用 pt-*,不能用 py-*:
          py-6 / lg:py-10 会把 padding-top 覆盖成 24/40px(响应式变体 lg:py-10
          在生成 CSS 里还排在 pt-16 之后),小于顶栏 64px,首个元素(返回按钮)
          会被压到顶栏后面 —— 这正是「PC 看不到返回按钮、手机平板正常」的根因。 */}
      <main className="ml-0 pt-16 px-4 md:px-8 lg:px-10 pb-6 lg:pb-10">
        {/* 返回按钮(仅详情页且有上次搜索结果时显示)与 BGM 登录状态同行左右分布,
            避免各占一行导致上下大片空白。 */}
        <div className="flex justify-between items-center mb-3 min-h-[24px]">
          {state.status === 'detail' && lastResultState.current ? (
            <button
              onClick={() => {
                pendingScrollRestore.current = true
                setState(lastResultState.current!)
              }}
              className="flex items-center gap-1.5 text-on-surface-variant/50 hover:text-primary transition-colors font-label text-xs uppercase tracking-wider group"
            >
              <span className="material-symbols-outlined text-base leading-none group-hover:-translate-x-0.5 transition-transform">
                arrow_back
              </span>
              Back to results
            </button>
          ) : (
            <span />
          )}
          <BgmLoginChip />
        </div>
        {state.status === 'idle' && <IdleState />}
        {(state.status === 'searching' || state.status === 'loading') && (
          <LoadingSpinner
            progress={state.status === 'searching' && state.mode === 'online' ? searchProgress : null}
            label={
              state.status === 'loading'
                ? 'Loading detail...'
                : state.mode === 'online'
                  ? '正在在线搜索…'
                  : '正在搜索本地数据…'
            }
          />
        )}
        {state.status === 'results' && (
          <SearchResults
            items={state.items}
            mode={state.mode}
            onOnlineSearch={() => void handleOnlineSearch(state.keyword, state.kind)}
            onSelect={loadDetail}
          />
        )}
        {state.status === 'empty' && (
          <EmptySearchState
            message={state.message}
            mode={state.mode}
            onOnlineSearch={() => void handleOnlineSearch(state.keyword, state.kind)}
          />
        )}
        {state.status === 'detail' && (
          <DetailView
            data={state.data}
            onArchive={() => setArchiveKeyword(lastBgmKeyword.current || state.data.title_cn || state.data.title)}
          />
        )}
        {state.status === 'error' && (
          <div className="max-w-3xl mx-auto">
            <ErrorPanel
              error={state.message}
              onRetry={
                state.keyword && state.kind
                  ? () => void (state.mode === 'online'
                    ? handleOnlineSearch(state.keyword!, state.kind!)
                    : handleOfflineSearch(state.keyword!, state.kind!))
                  : () => setState({ status: 'idle' })
              }
              retryLabel={state.mode === 'online' ? '重试在线搜索' : '重试'}
            />
            {state.mode === 'offline' && state.keyword && state.kind && (
              <div className="flex justify-center mt-4">
                <button
                  type="button"
                  onClick={() => void handleOnlineSearch(state.keyword!, state.kind!)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-primary/35 bg-primary/10 text-primary hover:bg-primary/15 transition-colors font-label text-sm font-bold"
                >
                  <span className="material-symbols-outlined text-lg leading-none">language</span>
                  在线搜索
                </button>
              </div>
            )}
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
