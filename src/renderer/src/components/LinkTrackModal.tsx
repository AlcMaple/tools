// 迷你 BGM 搜索弹窗 —— 用户需要把一个源的搜索结果关联到规范的 BGM 条目时用。
//
// 用预填的关键词(清洗过的源标题)打开 → 用户可以改词重搜 → 选中一条后回调把 BGM 详情交给
// 调用方去写 binding。
// 复用主进程的搜索进度事件显示「第 X / Y 页」—— 多页查询每页要等 2 秒以上限速,没有反馈会很难熬。

import { useEffect, useRef, useState } from 'react'
import type { BgmSearchResult, BgmDetail } from '../types/bgm'
import { ModalShell } from '../pages/homework/shared'
import ErrorPanel from './ErrorPanel'

interface Props {
  /** 初始关键词。 */
  initialKeyword: string
  /** 正在关联的是哪个源 / 哪个标题,给用户看的上下文。 */
  sourceLabel: string
  sourceTitle: string
  onClose: () => void
  /** 选中后回调,由调用方写 binding 并关闭弹窗。 */
  onConfirm: (detail: BgmDetail) => void
}

type State =
  | { status: 'searching'; mode: 'offline' | 'online' }
  | { status: 'results'; items: BgmSearchResult[]; mode: 'offline' | 'online' }
  | { status: 'loadingDetail' }
  | { status: 'error'; message: string; mode: 'offline' | 'online' }
  | { status: 'empty'; message: string; mode: 'offline' | 'online' }

function extractSubjectId(link: string): number | null {
  const m = link.match(/\/subject\/(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

export function LinkTrackModal({ initialKeyword, sourceLabel, sourceTitle, onClose, onConfirm }: Props): JSX.Element {
  const [keyword, setKeyword] = useState(initialKeyword)
  const [state, setState] = useState<State>({ status: 'searching', mode: 'offline' })
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const reqIdRef = useRef(0)
  // 在线请求 settle 前保持互斥：回车、本地按钮和在线按钮都不能再启动搜索。
  const onlineSearchActiveRef = useRef(false)

  // 整个弹窗生命周期只订阅一次。
  useEffect(() => {
    const unsub = window.bgmApi.onSearchProgress((current, total) => {
      if (onlineSearchActiveRef.current) setProgress({ current, total })
    })
    return () => {
      onlineSearchActiveRef.current = false
      reqIdRef.current += 1
      unsub()
    }
  }, [])

  // 初始、回车和「搜索」都只查本地数据。request id 保证后发操作获胜。
  const runOfflineSearch = async (kw: string): Promise<void> => {
    if (onlineSearchActiveRef.current) return
    const trimmed = kw.trim()
    if (!trimmed) return
    const myId = ++reqIdRef.current
    onlineSearchActiveRef.current = false
    setProgress(null)
    setState({ status: 'searching', mode: 'offline' })
    try {
      const result = await window.bgmApi.searchOffline(trimmed, 2)
      if (myId !== reqIdRef.current) return
      if (!result.supported) {
        setState({ status: 'empty', mode: 'offline', message: '当前类目请使用在线搜索' })
        return
      }
      if (!result.ready) {
        setState({ status: 'empty', mode: 'offline', message: '本地数据正在准备' })
        return
      }
      if (!Array.isArray(result.items) || result.items.length === 0) {
        setState({ status: 'empty', mode: 'offline', message: '本地结果中没有找到相关条目' })
        return
      }
      // 本地索引已按相关度排序，原样展示。
      setState({ status: 'results', items: result.items, mode: 'offline' })
    } catch (err) {
      if (myId !== reqIdRef.current) return
      setState({ status: 'error', message: String(err), mode: 'offline' })
    }
  }

  const runOnlineSearch = async (kw: string): Promise<void> => {
    if (onlineSearchActiveRef.current) return
    const trimmed = kw.trim()
    if (!trimmed) return
    const myId = ++reqIdRef.current
    onlineSearchActiveRef.current = true
    setProgress(null)
    setState({ status: 'searching', mode: 'online' })
    try {
      const items = await window.bgmApi.searchOnline(trimmed, true, 2)
      if (myId !== reqIdRef.current) return
      const sorted = [...(Array.isArray(items) ? items : [])].sort((a, b) => {
        const da = /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : '0000-00-00'
        const db = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '0000-00-00'
        return db.localeCompare(da)
      })
      if (sorted.length === 0) {
        setState({ status: 'empty', mode: 'online', message: '在线搜索没有找到相关条目' })
      } else {
        setState({ status: 'results', items: sorted, mode: 'online' })
      }
    } catch (err) {
      if (myId !== reqIdRef.current) return
      setState({ status: 'error', message: String(err), mode: 'online' })
    } finally {
      if (myId === reqIdRef.current) {
        onlineSearchActiveRef.current = false
        setProgress(null)
      }
    }
  }

  useEffect(() => {
    void runOfflineSearch(initialKeyword)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = async (item: BgmSearchResult): Promise<void> => {
    const resultMode = state.status === 'results' ? state.mode : 'offline'
    const myId = ++reqIdRef.current
    onlineSearchActiveRef.current = false
    setProgress(null)
    const sid = extractSubjectId(item.link)
    if (!sid) {
      setState({ status: 'error', message: '解析条目 ID 失败', mode: resultMode })
      return
    }
    setState({ status: 'loadingDetail' })
    try {
      const detail = await window.bgmApi.detail(sid)
      if (myId !== reqIdRef.current) return
      onConfirm(detail)
    } catch (err) {
      if (myId !== reqIdRef.current) return
      setState({ status: 'error', message: String(err), mode: resultMode })
    }
  }

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex flex-col max-h-[70vh]">
        {/* Header — source context */}
        <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-headline font-black text-base text-on-surface">关联追番</h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">
                {sourceLabel}
              </p>
              <p className="font-body text-xs text-on-surface-variant/80 mt-2 truncate" title={sourceTitle}>
                {sourceTitle}
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
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[180px] flex items-center bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 gap-2 focus-within:border-primary/40 transition-colors">
              <span className="material-symbols-outlined text-on-surface-variant/40 text-base leading-none">search</span>
              <input
                type="text"
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void runOfflineSearch(keyword) }}
                placeholder="搜索动画标题..."
                autoFocus
                spellCheck={false}
                className="flex-1 bg-transparent outline-none text-sm text-on-surface placeholder:text-on-surface-variant/35"
              />
            </div>
            <button
              onClick={() => void runOfflineSearch(keyword)}
              disabled={
                !keyword.trim()
                || (state.status === 'searching' && state.mode === 'online')
                || state.status === 'loadingDetail'
              }
              className="px-4 py-2.5 rounded-lg bg-primary text-on-primary font-label text-xs font-bold tracking-widest hover:brightness-110 transition-colors active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            >
              搜索
            </button>
            <button
              onClick={() => void runOnlineSearch(keyword)}
              disabled={
                !keyword.trim()
                || (state.status === 'searching' && state.mode === 'online')
                || state.status === 'loadingDetail'
              }
              className="px-3 py-2.5 rounded-lg border border-outline-variant/25 bg-surface-container text-on-surface-variant hover:text-primary hover:border-primary/35 transition-colors font-label text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            >
              在线搜索
            </button>
          </div>
          <p className="mt-2 font-label text-[9px] text-on-surface-variant/40">
            默认从本地结果中挑选；找不到或结果不理想时再在线搜索。
          </p>
        </div>

        {/* Result area — scroll inside */}
        <div className="custom-scrollbar overflow-y-auto flex-1 px-3 pb-5 min-h-[160px]">
          {state.status === 'searching' && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <span
                className="material-symbols-outlined text-primary/60 text-3xl animate-spin"
                style={{ animationDuration: '1.2s' }}
              >
                progress_activity
              </span>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest">
                {state.mode === 'online' ? '正在在线搜索…' : '正在搜索本地数据…'}
              </p>
              {state.mode === 'online' && progress && progress.total > 1 && (
                <p className="font-label text-[10px] text-on-surface-variant/40 tracking-wider">
                  Page {progress.current} / {progress.total}
                </p>
              )}
            </div>
          )}

          {state.status === 'loadingDetail' && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <span
                className="material-symbols-outlined text-primary/60 text-3xl animate-spin"
                style={{ animationDuration: '1.2s' }}
              >
                progress_activity
              </span>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest">
                Fetching detail...
              </p>
            </div>
          )}

          {state.status === 'empty' && (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-on-surface-variant/45 text-center">
              <span className="material-symbols-outlined text-3xl">search_off</span>
              <p className="font-label text-xs text-on-surface-variant/70">{state.message}</p>
              <p className="font-label text-[10px]">
                {state.mode === 'offline' ? '可调整关键词，或继续在线搜索' : '可以换个关键词再试'}
              </p>
            </div>
          )}

          {state.status === 'error' && (
            <ErrorPanel
              error={state.message}
              onRetry={() => void (state.mode === 'online' ? runOnlineSearch(keyword) : runOfflineSearch(keyword))}
              retryLabel={state.mode === 'online' ? '重试在线搜索' : '重试搜索'}
              compact
            />
          )}

          {state.status === 'results' && (
            <div className="px-2 pt-1">
              <p className="px-2 pb-2 font-label text-[9px] text-on-surface-variant/40 uppercase tracking-widest">
                {state.mode === 'offline' ? '本地结果' : '在线结果'} · {state.items.length}
              </p>
              <ul className="space-y-1.5">
                {state.items.map(item => (
                  <li key={item.link}>
                    <button
                      onClick={() => void pick(item)}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-surface hover:bg-surface-container-highest border border-outline-variant/10 hover:border-primary/30 text-left transition-colors group"
                    >
                      <div className="min-w-0">
                        <p className="font-bold text-on-surface text-sm group-hover:text-primary transition-colors truncate">
                          {item.title}
                        </p>
                        <p className="font-label text-[10px] text-on-surface-variant/50 mt-0.5 uppercase tracking-widest">
                          {item.date || '日期未知'}
                          {item.rate && item.rate !== 'N/A' && <span className="ml-2 text-primary/60">★ {item.rate}</span>}
                        </p>
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant/20 group-hover:text-primary/60 transition-colors text-base shrink-0">
                        arrow_forward
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  )
}
