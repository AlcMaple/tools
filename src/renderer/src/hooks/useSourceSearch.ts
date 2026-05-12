// 三大动漫源（Aowu / Xifan / Girigiri）的搜索状态机 hook。
//
// 抽出来是因为 SearchDownload（用户输入关键词主动搜）和 MyAnime 的
// SearchSourceModal（补搜其他源，自动用 BGM 标题预填）走的是完全同一
// 套流程：缓存命中早返 → API 搜索 → 必要时验证码 → 写缓存 → 出结果。
// 任何一处行为漂移都要改两处，所以集中到这一个文件。
//
// 涵盖：
//   - 搜索缓存读写（isSearchCacheEnabled + getCachedSearch + setCachedSearch）
//   - Xifan / Girigiri 验证码流（getCaptcha → setState captcha → verifyCaptcha
//     → 成功后自动重跑上一次的 keyword）
//   - Aowu 流式分页（onSearchPage 增量 push 进 results.cards，并把合并后的
//     完整列表回写缓存，让下次命中就是全量）
//   - reqIdRef 串行化：用户连点搜索 / strict mode 双 fire / 异步竞速都不会
//     让旧请求覆盖新状态
//   - aowuStreamUnsubRef：上一次搜索的 onSearchPage 监听在新搜索开始时取消,
//     防止 stale 页 push 到新的 cards
//   - 可选 initialKeyword：传了就 mount 时自动搜一次（含 startedRef 守 strict
//     mode 双 fire）；不传就静默等用户主动调 search()

import { useEffect, useRef, useState } from 'react'
import {
  isSearchCacheEnabled,
  getCachedSearch,
  setCachedSearch,
} from '../utils/searchCache'
import {
  normalizeAowu,
  normalizeGirigiri,
  normalizeXifan,
} from '../utils/searchNormalize'
import type { SearchCard, Source } from '../types/search'

export type SourceSearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'captcha'; imageB64: string; error?: string }
  | { status: 'verifying' }
  | { status: 'results'; cards: SearchCard[]; fromCache: boolean }
  | { status: 'empty' }
  | { status: 'error'; message: string }

export interface UseSourceSearchResult {
  state: SourceSearchState
  /** Trigger a search. Idempotent; latest call wins via reqId. */
  search: (keyword: string) => Promise<void>
  /** Refresh the captcha image while in captcha state. No-op otherwise. */
  refreshCaptcha: () => Promise<void>
  /** Submit captcha code; on success re-runs the last keyword. */
  verifyCaptcha: (code: string) => Promise<void>
  /** Manually reset to idle (e.g. when caller closes a modal). */
  reset: () => void
}

interface UseSourceSearchOptions {
  /** If provided, auto-search this keyword once on mount (strict-mode-safe). */
  initialKeyword?: string
}

export function useSourceSearch(
  source: Source,
  opts: UseSourceSearchOptions = {},
): UseSourceSearchResult {
  // Initial state defaults to 'searching' when there's an initial keyword,
  // so the first render shows a spinner instead of empty space — users
  // mistake empty space for "no results found".
  const [state, setState] = useState<SourceSearchState>(() =>
    opts.initialKeyword && opts.initialKeyword.trim()
      ? { status: 'searching' }
      : { status: 'idle' },
  )
  const reqIdRef = useRef(0)
  const lastKeywordRef = useRef('')
  const aowuStreamUnsubRef = useRef<(() => void) | null>(null)
  const currentAowuReqIdRef = useRef<string | null>(null)
  const startedRef = useRef(false)

  // Cleanup stream listener on unmount so a closing modal doesn't keep
  // receiving onSearchPage events into a dead state setter.
  useEffect(() => {
    return () => {
      aowuStreamUnsubRef.current?.()
      aowuStreamUnsubRef.current = null
    }
  }, [])

  const search = async (keyword: string): Promise<void> => {
    const kw = keyword.trim()
    if (!kw) return
    lastKeywordRef.current = kw
    const myId = ++reqIdRef.current

    // Any in-flight Aowu stream belongs to the previous search; kill it
    // before we start collecting new pages.
    aowuStreamUnsubRef.current?.()
    aowuStreamUnsubRef.current = null
    currentAowuReqIdRef.current = null

    const safeSet = (next: SourceSearchState): void => {
      if (myId !== reqIdRef.current) return
      setState(next)
    }

    // Cache lookup first. A non-stale hit returns synchronously without
    // touching the network. Stale hits fall through to fetch — we could
    // also kick off a background refresh here but for simplicity the modal
    // / page just shows the new results when they arrive.
    if (isSearchCacheEnabled()) {
      const hit = await getCachedSearch(kw, source)
      if (myId !== reqIdRef.current) return
      if (hit && !hit.isStale) {
        safeSet({ status: 'results', cards: hit.data, fromCache: true })
        return
      }
    }

    safeSet({ status: 'searching' })

    try {
      if (source === 'Aowu') {
        const { requestId, results, more } = await window.aowuApi.search(kw)
        if (myId !== reqIdRef.current) return
        currentAowuReqIdRef.current = requestId
        const cards = results.map(normalizeAowu)
        if (cards.length === 0 && !more) {
          safeSet({ status: 'empty' })
          return
        }
        safeSet({ status: 'results', cards, fromCache: false })
        if (cards.length > 0) void setCachedSearch(kw, source, cards)
        if (more) {
          aowuStreamUnsubRef.current = window.aowuApi.onSearchPage(
            (rid, page, done) => {
              if (rid !== currentAowuReqIdRef.current) return
              if (myId !== reqIdRef.current) return
              if (page.length > 0) {
                const morecards = page.map(normalizeAowu)
                setState((prev) => {
                  if (prev.status !== 'results') return prev
                  const merged = [...prev.cards, ...morecards]
                  // Write through after every page so a kill mid-stream
                  // still leaves the cache with what we've collected so far.
                  void setCachedSearch(kw, source, merged)
                  return { ...prev, cards: merged }
                })
              }
              if (done) {
                aowuStreamUnsubRef.current?.()
                aowuStreamUnsubRef.current = null
              }
            },
          )
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
        if (cards.length === 0) {
          safeSet({ status: 'empty' })
        } else {
          safeSet({ status: 'results', cards, fromCache: false })
          void setCachedSearch(kw, source, cards)
        }
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
        if (cards.length === 0) {
          safeSet({ status: 'empty' })
        } else {
          safeSet({ status: 'results', cards, fromCache: false })
          void setCachedSearch(kw, source, cards)
        }
      }
    } catch (err) {
      safeSet({ status: 'error', message: String(err) })
    }
  }

  const refreshCaptcha = async (): Promise<void> => {
    if (state.status !== 'captcha') return
    const api =
      source === 'Girigiri' ? window.girigiriApi
      : source === 'Xifan' ? window.xifanApi
      : null
    if (!api) return
    try {
      const { image_b64 } = await api.getCaptcha()
      setState({ status: 'captcha', imageB64: image_b64 })
    } catch {
      /* swallow — user can just click refresh again */
    }
  }

  const verifyCaptcha = async (code: string): Promise<void> => {
    if (state.status !== 'captcha') return
    const api =
      source === 'Girigiri' ? window.girigiriApi
      : source === 'Xifan' ? window.xifanApi
      : null
    if (!api) return
    setState({ status: 'verifying' })
    try {
      const { success } = await api.verifyCaptcha(code.trim())
      if (success) {
        // Re-run the keyword that originally tripped captcha. search() bumps
        // reqId so any leftover from before-verify is invalidated.
        await search(lastKeywordRef.current)
      } else {
        const { image_b64 } = await api.getCaptcha()
        setState({
          status: 'captcha',
          imageB64: image_b64,
          error: '验证码错误，重试',
        })
      }
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    }
  }

  const reset = (): void => {
    reqIdRef.current++
    aowuStreamUnsubRef.current?.()
    aowuStreamUnsubRef.current = null
    setState({ status: 'idle' })
  }

  // Auto-search on mount when initialKeyword is provided. startedRef +
  // refs persist across strict-mode fake-unmount/remount so we only kick
  // off one search even though useEffect fires twice in dev.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const k = opts.initialKeyword?.trim()
    if (k) void search(k)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { state, search, refreshCaptcha, verifyCaptcha, reset }
}
