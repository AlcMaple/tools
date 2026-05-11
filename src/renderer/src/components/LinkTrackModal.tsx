// Mini BGM search modal — used by SearchDownload (and later, anywhere a user
// needs to associate a source result with a canonical Bangumi entry).
//
// Flow:
//   1. Open with a prefilled keyword (cleaned source title)
//   2. User can edit + re-search
//   3. Pick a result → call `onConfirm` with the BgmDetail so the caller can
//      write the binding into animeTrackStore
//
// Reuses the existing BGM search progress event for "Page X / Y" feedback —
// multi-page lookups can take ≥2s each due to the rate limiter.

import { useEffect, useRef, useState } from 'react'
import type { BgmSearchResult, BgmDetail } from '../types/bgm'
import { ModalShell } from '../pages/homework/shared'

interface Props {
  /** Initial keyword used to seed the search box. */
  initialKeyword: string
  /** What source/title we're trying to link, shown to the user as context. */
  sourceLabel: string
  sourceTitle: string
  onClose: () => void
  /** Called with the picked BGM detail. Caller writes the binding + closes. */
  onConfirm: (detail: BgmDetail) => void
}

type State =
  | { status: 'searching' }
  | { status: 'results'; items: BgmSearchResult[] }
  | { status: 'loadingDetail' }
  | { status: 'error'; message: string }
  | { status: 'empty' }

function extractSubjectId(link: string): number | null {
  const m = link.match(/\/subject\/(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

export function LinkTrackModal({ initialKeyword, sourceLabel, sourceTitle, onClose, onConfirm }: Props): JSX.Element {
  const [keyword, setKeyword] = useState(initialKeyword)
  const [state, setState] = useState<State>({ status: 'searching' })
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const reqIdRef = useRef(0)

  // Subscribe once for the modal lifetime. Progress events are page-counted by
  // main; the BGM rate-limiter spaces requests 2.2-2.8s so this feedback is
  // important on multi-page queries.
  useEffect(() => {
    const unsub = window.bgmApi.onSearchProgress((current, total) => {
      setProgress({ current, total })
    })
    return unsub
  }, [])

  // Initial + subsequent searches share this function. Bumps a request id so a
  // stale (slow) result that lands after the user hit Enter again is discarded.
  const runSearch = async (kw: string): Promise<void> => {
    const trimmed = kw.trim()
    if (!trimmed) return
    const myId = ++reqIdRef.current
    setProgress(null)
    setState({ status: 'searching' })
    try {
      // We don't pass `update=true` — the renderer cache is a fine fast path
      // here, and the main-process disk cache further insulates us from BGM
      // rate limits when the user re-uses the same keyword across cards.
      const items = await window.bgmApi.search(trimmed)
      if (myId !== reqIdRef.current) return
      if (!Array.isArray(items) || items.length === 0) {
        setState({ status: 'empty' })
        return
      }
      // Sort: newest air date first, undated last.
      const sorted = [...items].sort((a, b) => {
        const da = /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : '0000-00-00'
        const db = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '0000-00-00'
        return db.localeCompare(da)
      })
      setState({ status: 'results', items: sorted })
    } catch (err) {
      if (myId !== reqIdRef.current) return
      setState({ status: 'error', message: String(err) })
    } finally {
      if (myId === reqIdRef.current) setProgress(null)
    }
  }

  useEffect(() => {
    void runSearch(initialKeyword)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = async (item: BgmSearchResult): Promise<void> => {
    const sid = extractSubjectId(item.link)
    if (!sid) {
      setState({ status: 'error', message: '解析条目 ID 失败' })
      return
    }
    setState({ status: 'loadingDetail' })
    try {
      const detail = await window.bgmApi.detail(sid)
      onConfirm(detail)
    } catch (err) {
      setState({ status: 'error', message: String(err) })
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
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 gap-2 focus-within:border-primary/40 transition-colors">
              <span className="material-symbols-outlined text-on-surface-variant/40 text-base leading-none">search</span>
              <input
                type="text"
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void runSearch(keyword) }}
                placeholder="Bangumi 关键词..."
                autoFocus
                spellCheck={false}
                className="flex-1 bg-transparent outline-none text-sm text-on-surface placeholder:text-on-surface-variant/35"
              />
            </div>
            <button
              onClick={() => void runSearch(keyword)}
              disabled={!keyword.trim() || state.status === 'searching'}
              className="px-4 py-2.5 rounded-lg bg-primary text-on-primary font-label text-xs font-bold tracking-widest hover:brightness-110 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              搜索
            </button>
          </div>
          <p className="mt-2 font-label text-[10px] text-on-surface-variant/40">
            从 BGM 搜索结果里挑一个对应条目，绑定后该来源就永久关联到这部番。
          </p>
        </div>

        {/* Result area — scroll inside */}
        <div className="overflow-y-auto flex-1 px-3 pb-5 min-h-[160px]">
          {state.status === 'searching' && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <span
                className="material-symbols-outlined text-primary/60 text-3xl animate-spin"
                style={{ animationDuration: '1.2s' }}
              >
                progress_activity
              </span>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest">
                Querying Bangumi...
              </p>
              {progress && progress.total > 1 && (
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
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-on-surface-variant/40">
              <span className="material-symbols-outlined text-3xl">search_off</span>
              <p className="font-label text-xs">没有找到相关条目，试着换关键词</p>
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
              {state.items.map(item => (
                <li key={item.link}>
                  <button
                    onClick={() => void pick(item)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-surface hover:bg-surface-container-highest border border-outline-variant/10 hover:border-primary/30 text-left transition-all group"
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
          )}
        </div>
      </div>
    </ModalShell>
  )
}
