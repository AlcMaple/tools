// 三个内置源的搜索状态机。
//
// 抽出来是因为「搜索下载页」和「补搜其他源」走的是完全同一套流程:命中缓存早返 → 搜索 →
// 必要时验证码 → 写缓存 → 出结果。放两份的话任何行为漂移都要改两处。
//
// 涵盖:
//   - 搜索缓存读写
//   - 验证码流(取图 → 进 captcha 态 → 提交 → 成功后自动重跑上一次的关键词)
//   - 嗷呜的流式分页(后续页增量 push 进结果,并把合并后的完整列表回写缓存,让下次命中即全量)
//   - `reqIdRef` 串行化:连点搜索、strict mode 双触发、异步竞速都不会让旧请求覆盖新状态
//   - 新搜索开始时取消上一次的流式监听,防止旧页 push 进新结果
//   - 可选 initialKeyword:传了就在挂载时自动搜一次

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
  /** 发起搜索。幂等,按 reqId 后来者胜。 */
  search: (keyword: string) => Promise<void>
  /** 在验证码状态下换一张图,其他状态是空操作。 */
  refreshCaptcha: () => Promise<void>
  /** 提交验证码;成功后自动重跑上一次的关键词。 */
  verifyCaptcha: (code: string) => Promise<void>
  /** 手动复位到 idle(比如调用方关掉了弹窗)。 */
  reset: () => void
}

interface UseSourceSearchOptions {
  /** 传了就在挂载时自动搜这个词一次(对 strict mode 双触发安全)。 */
  initialKeyword?: string
}

export function useSourceSearch(
  source: Source,
  opts: UseSourceSearchOptions = {},
): UseSourceSearchResult {
  // 有初始关键词时初始状态直接是 searching,让首屏显示 spinner 而不是空白 —— 用户会把空白
  // 误当成「没搜到结果」。
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

  // 卸载时取消流式监听,免得弹窗关掉后还在往一个已失效的 setState 里推事件。
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

    // 还在飞的嗷呜流属于上一次搜索,开始收新页之前先掐掉。
    aowuStreamUnsubRef.current?.()
    aowuStreamUnsubRef.current = null
    currentAowuReqIdRef.current = null

    const safeSet = (next: SourceSearchState): void => {
      if (myId !== reqIdRef.current) return
      setState(next)
    }

    // 先查缓存:未过期的命中直接同步返回、不碰网络;过期的落到下面照常联网。
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
                  // 每页都写一次缓存 —— 中途被打断时,已收到的部分仍留在缓存里。
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
        // 重跑当初触发验证码的那个关键词;search() 会推进 reqId,验证前的残留自动作废。
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

  // ref 在 strict mode 的假卸载/重挂之间保留,所以 dev 下 effect 触发两次也只会真搜一次。
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const k = opts.initialKeyword?.trim()
    if (k) void search(k)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { state, search, refreshCaptcha, verifyCaptcha, reset }
}
