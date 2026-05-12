// 补搜其他源弹窗 —— 用于 MyAnime 的「+ 搜 Xifan / + 搜 Girigiri / + 搜 Aowu」
// 入口。和 LinkTrackModal（BGM 搜索）不同，这里目标是某个具体的视频源,
// 用户挑一个结果就直接写到追番条目的 bindings 里。
//
// 行为：
//   1. 用 BGM 标题预填关键词，用户可编辑后再搜
//   2. Xifan / Girigiri 有验证码就内联展示，过完接着搜
//   3. Aowu 走流式（第一页同步返回，后续页通过 onSearchPage 流过来）
//   4. 用户点结果 → 算出 SearchCard → 交回 onConfirm，调用方写 binding
//
// 不在这里写 binding —— 因为 Aowu 还要 await resolveShareUrl 拿 /w/{token}
// URL，那是调用方的领域；这里只负责"挑出用户想要的源条目"。

import { useEffect, useRef, useState } from 'react'
import { ModalShell } from '../pages/homework/shared'
import type { Source, SearchCard } from '../types/search'
import {
  normalizeAowu,
  normalizeGirigiri,
  normalizeXifan,
} from '../utils/searchNormalize'

interface Props {
  source: Source
  /** 初始关键词，一般传 track.titleCn || track.title。 */
  initialKeyword: string
  /** 头部展示用，让用户知道在为哪部番找。 */
  animeTitle: string
  onClose: () => void
  /** 用户挑了一个结果。调用方根据 source 自己处理（Aowu 要再 resolveShareUrl）。 */
  onConfirm: (card: SearchCard) => void | Promise<void>
}

type State =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'captcha'; imageB64: string; error?: string }
  | { status: 'verifying' }
  | { status: 'results'; cards: SearchCard[] }
  | { status: 'empty' }
  | { status: 'error'; message: string }
  | { status: 'confirming' } // Aowu 等异步 resolveShareUrl 时停一下

export function SearchSourceModal({ source, initialKeyword, animeTitle, onClose, onConfirm }: Props): JSX.Element {
  const [keyword, setKeyword] = useState(initialKeyword)
  // 初始就给 'searching' —— 只要有预填关键词，挂载后第一件事就是搜，
  // 用 'idle' 渲染空白会让用户误以为"没找到"。
  const [state, setState] = useState<State>(() =>
    initialKeyword.trim() ? { status: 'searching' } : { status: 'idle' },
  )
  const [captchaInput, setCaptchaInput] = useState('')
  const aowuStreamUnsubRef = useRef<(() => void) | null>(null)
  const currentReqIdRef = useRef<string | null>(null)
  // 串行化 doSearch 的请求 id。新一次搜索递增，旧请求的回调里发现
  // myId !== reqIdRef.current 就 bail，不再 setState。防止 strict mode
  // 双 fire / 用户连击搜索按钮等场景里旧请求覆盖新状态。
  const reqIdRef = useRef(0)
  // 防 strict mode 双 fire：useEffect 重跑时 startedRef 已经是 true,
  // 跳过本次初始搜索（refs 跨 fake-unmount 持久）。
  const startedRef = useRef(false)

  // 卸载时清掉 aowu 流监听，避免 stale modal 还在收新页
  useEffect(() => {
    return () => {
      aowuStreamUnsubRef.current?.()
    }
  }, [])

  // 首次进来自动跑一次搜索（strict mode 双 fire 用 startedRef 守住）
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    if (initialKeyword.trim()) {
      void doSearch(initialKeyword.trim())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function doSearch(kw: string): Promise<void> {
    if (!kw) return
    const myId = ++reqIdRef.current
    aowuStreamUnsubRef.current?.()
    aowuStreamUnsubRef.current = null
    currentReqIdRef.current = null
    setState({ status: 'searching' })
    setCaptchaInput('')

    // 包装所有 setState：仅在本请求还是最新时才执行。封一层避免每处
    // 都写 if (myId !== reqIdRef.current) return。
    const safeSet = (next: State): void => {
      if (myId !== reqIdRef.current) return
      setState(next)
    }

    try {
      if (source === 'Aowu') {
        // 流式：第一页同步拿，剩下的通过 onSearchPage 接力
        const { requestId, results, more } = await window.aowuApi.search(kw)
        if (myId !== reqIdRef.current) return
        currentReqIdRef.current = requestId
        const cards = results.map(normalizeAowu)
        if (cards.length === 0 && !more) {
          safeSet({ status: 'empty' })
          return
        }
        safeSet({ status: 'results', cards })
        if (more) {
          aowuStreamUnsubRef.current = window.aowuApi.onSearchPage((rid, page, done) => {
            if (rid !== currentReqIdRef.current) return
            if (myId !== reqIdRef.current) return
            if (page.length > 0) {
              const moreCards = page.map(normalizeAowu)
              setState((prev) =>
                prev.status === 'results' ? { ...prev, cards: [...prev.cards, ...moreCards] } : prev,
              )
            }
            if (done) {
              aowuStreamUnsubRef.current?.()
              aowuStreamUnsubRef.current = null
            }
          })
        }
      } else if (source === 'Girigiri') {
        const result = await window.girigiriApi.search(kw)
        if (myId !== reqIdRef.current) return
        if (!Array.isArray(result) && result.needs_captcha) {
          const { image_b64 } = await window.girigiriApi.getCaptcha()
          safeSet({ status: 'captcha', imageB64: image_b64 })
          return
        }
        const arr = Array.isArray(result) ? result : []
        const cards = arr.map(normalizeGirigiri)
        safeSet(cards.length === 0 ? { status: 'empty' } : { status: 'results', cards })
      } else {
        // Xifan
        const result = await window.xifanApi.search(kw)
        if (myId !== reqIdRef.current) return
        if (!Array.isArray(result) && result.needs_captcha) {
          const { image_b64 } = await window.xifanApi.getCaptcha()
          safeSet({ status: 'captcha', imageB64: image_b64 })
          return
        }
        const arr = Array.isArray(result) ? result : []
        const cards = arr.map(normalizeXifan)
        safeSet(cards.length === 0 ? { status: 'empty' } : { status: 'results', cards })
      }
    } catch (err) {
      safeSet({ status: 'error', message: String(err) })
    }
  }

  async function handleVerify(): Promise<void> {
    if (state.status !== 'captcha') return
    const api = source === 'Girigiri' ? window.girigiriApi : window.xifanApi
    setState({ status: 'verifying' })
    try {
      const { success } = await api.verifyCaptcha(captchaInput.trim())
      if (success) {
        await doSearch(keyword.trim())
      } else {
        const { image_b64 } = await api.getCaptcha()
        setCaptchaInput('')
        setState({ status: 'captcha', imageB64: image_b64, error: '验证码错误，重试' })
      }
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    }
  }

  async function handleRefreshCaptcha(): Promise<void> {
    if (state.status !== 'captcha') return
    const api = source === 'Girigiri' ? window.girigiriApi : window.xifanApi
    try {
      const { image_b64 } = await api.getCaptcha()
      setCaptchaInput('')
      setState({ status: 'captcha', imageB64: image_b64 })
    } catch {
      /* noop */
    }
  }

  async function pickCard(card: SearchCard): Promise<void> {
    setState({ status: 'confirming' })
    try {
      await onConfirm(card)
      // onConfirm 内部一般会 setSearching(null) 关弹窗，这里不主动 close
      // 以避免双重关闭
    } catch (err) {
      setState({ status: 'error', message: `绑定失败：${String(err)}` })
    }
  }

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-headline font-black text-base text-on-surface">
                补绑 {source} 源
              </h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">
                {animeTitle}
              </p>
              <p className="font-body text-[11px] text-on-surface-variant/60 mt-1.5">
                从 {source} 的搜索结果里挑一个对应条目，绑定后这个源也会出现在「在线观看」chip 里。
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0"
            >
              <span className="material-symbols-outlined leading-none">close</span>
            </button>
          </div>
        </div>

        {/* Search box */}
        <div className="p-5 pb-3 shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 gap-2 focus-within:border-primary/40 transition-colors">
              <span className="material-symbols-outlined text-on-surface-variant/40 text-base leading-none">search</span>
              <input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(keyword.trim()) }}
                placeholder={`${source} 关键词...`}
                autoFocus
                spellCheck={false}
                className="flex-1 bg-transparent outline-none text-sm text-on-surface placeholder:text-on-surface-variant/35"
              />
            </div>
            <button
              onClick={() => void doSearch(keyword.trim())}
              disabled={!keyword.trim() || state.status === 'searching' || state.status === 'verifying'}
              className="px-4 py-2.5 rounded-lg bg-primary text-on-primary font-label text-xs font-bold tracking-widest hover:brightness-110 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              搜索
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-3 pb-5 min-h-[180px]">
          {(state.status === 'searching' || state.status === 'verifying' || state.status === 'confirming') && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <span
                className="material-symbols-outlined text-primary/60 text-3xl animate-spin"
                style={{ animationDuration: '1.2s' }}
              >
                progress_activity
              </span>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest">
                {state.status === 'verifying'
                  ? 'Verifying captcha...'
                  : state.status === 'confirming'
                    ? 'Binding...'
                    : `Querying ${source}...`}
              </p>
            </div>
          )}

          {state.status === 'captcha' && (
            <div className="px-2 pt-2 flex flex-col gap-3">
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest">
                {source} 需要先过验证码
              </p>
              <img
                src={`data:image/gif;base64,${state.imageB64}`}
                alt="captcha"
                className="w-full max-w-[280px] rounded-lg border border-outline-variant/20"
              />
              <input
                type="text"
                value={captchaInput}
                onChange={(e) => setCaptchaInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && captchaInput.trim()) void handleVerify() }}
                placeholder="输入验证码"
                autoFocus
                className="w-full max-w-[280px] bg-surface-container border border-outline-variant/20 rounded-lg px-3 py-2 text-sm text-on-surface tracking-[0.2em] outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30"
              />
              {state.error && <p className="font-label text-xs text-error">{state.error}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handleVerify()}
                  disabled={!captchaInput.trim()}
                  className="px-4 py-2 rounded-lg bg-primary text-on-primary font-label text-xs font-bold tracking-widest hover:brightness-110 disabled:opacity-40"
                >
                  确认
                </button>
                <button
                  onClick={() => void handleRefreshCaptcha()}
                  className="px-3 py-2 rounded-lg border border-outline-variant/20 text-on-surface-variant/70 font-label text-[10px] uppercase tracking-widest hover:bg-surface-container-high transition-colors flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[14px] leading-none">refresh</span>
                  换一张
                </button>
              </div>
            </div>
          )}

          {state.status === 'empty' && (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-on-surface-variant/40">
              <span className="material-symbols-outlined text-3xl">search_off</span>
              <p className="font-label text-xs">{source} 里没找到，换关键词试试</p>
            </div>
          )}

          {state.status === 'error' && (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-error">
              <span className="material-symbols-outlined text-3xl">error_outline</span>
              <p className="font-body text-xs text-on-surface-variant text-center px-6">{state.message}</p>
            </div>
          )}

          {state.status === 'results' && (
            <ul className="space-y-1.5 px-2 pt-1">
              {state.cards.map((card) => (
                <li key={card.key}>
                  <button
                    onClick={() => void pickCard(card)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-surface hover:bg-surface-container-highest border border-outline-variant/10 hover:border-primary/30 text-left transition-all group"
                  >
                    {card.cover ? (
                      <img
                        src={card.cover}
                        alt=""
                        className="w-10 aspect-[2/3] object-cover rounded shrink-0 bg-surface-container"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-10 aspect-[2/3] flex items-center justify-center text-on-surface-variant/20 bg-surface-container rounded shrink-0">
                        <span className="material-symbols-outlined text-base">image</span>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-on-surface text-sm group-hover:text-primary transition-colors truncate">
                        {card.title}
                      </p>
                      <p className="font-label text-[10px] text-on-surface-variant/50 mt-0.5 uppercase tracking-widest">
                        {[card.year, card.tag, card.count].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <span className="material-symbols-outlined text-on-surface-variant/20 group-hover:text-primary/60 transition-colors text-base shrink-0">
                      arrow_forward
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ModalShell>
  )
}
