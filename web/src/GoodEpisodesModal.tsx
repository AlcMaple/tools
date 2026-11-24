// 鉴赏神回弹窗 —— 参考桌面端 GoodEpisodesEditor，网页版重画成手帐纸片风格。
//
// 语义跟桌面端对齐（都是踩过坑定下来的，别改）：
//   - 数据是具体集号数组，不是计数；点即生效，不走草稿 —— 「勾清单」这种细碎动作每点一下
//     立刻写回才符合手感。
//   - 总集数未知（连载中）时网格上限取 max(当前观看集, 已标最高集, 1)，看到哪显示到哪，
//     不给「+N 扩展」按钮 —— 鉴赏神回语义上必须先看过那一集才能标。
//   - 取消标记会连带清掉那一集的备注，不留孤儿。
//
// 备注编辑：不用悬浮气泡（试过，锚定位置在弹窗里飘、点哪都可能溢出，还挡住内容）。
// 备注采用短 debounce 而不是只等失焦：切换集数或关闭弹窗前也要保住最后一笔，
// 同时避免每个字符都单独发请求；跟「全部集数」的网格点亮/取消仍是两个模式。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchTrackChapters, type Track } from './api'
import { EpisodeGrid } from './tracks/EpisodeGrid'
import { applyGoodEpisodeEdit, GOOD_EPISODE_NOTE_MAX_LENGTH, type GoodEpisodeEdit, type GoodEpisodeState } from '../shared/good-episodes'
import { Ic } from './SketchIcon'
import { episodeLabel, specialAt, type EpisodeDetails } from '../shared/episode-layout'

const ONGOING_MIN = 1

type ViewMode = 'all' | 'marked'

export function GoodEpisodesModal({
  t,
  onEdit,
  onClose,
}: {
  t: Track
  onEdit: (bgmId: number, edit: GoodEpisodeEdit) => void
  onClose: () => void
}): JSX.Element {
  const [view, setView] = useState<ViewMode>('all')
  const dismissTip = useRef<(() => void) | null>(null)
  const [details, setDetails] = useState<EpisodeDetails>()
  const [chapterError, setChapterError] = useState('')
  useEffect(() => {
    if (t.bgmId <= 0) return
    const controller = new AbortController()
    fetchTrackChapters(t.bgmId, controller.signal).then(data => {
      if (!controller.signal.aborted) setDetails(data)
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setChapterError(error.message)
    })
    return () => controller.abort()
  }, [t.bgmId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') (dismissTip.current ?? onClose)()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const episodes = t.goodEpisodes
  const notes = t.goodEpisodeNotes
  const marked = useMemo(() => new Set(episodes), [episodes])
  const [draftNotes, setDraftNotes] = useState<Record<number, string>>(notes)
  const latest = useRef<GoodEpisodeState>({ goodEpisodes: episodes, goodEpisodeNotes: notes })
  const pendingNotes = useRef(new Map<number, { text: string; timer: number }>())

  const takeNoteDraft = useCallback((n: number): string | undefined => {
    const draft = pendingNotes.current.get(n)
    if (!draft) return
    window.clearTimeout(draft.timer)
    pendingNotes.current.delete(n)
    return draft.text
  }, [])

  useLayoutEffect(() => {
    latest.current = { goodEpisodes: episodes, goodEpisodeNotes: notes }
    let next = notes
    // 还在防抖中的草稿不该被回读盖掉，但取消标记后它也不能跟着下一次点亮回来。
    for (const [n, draft] of pendingNotes.current) {
      if (!marked.has(n)) {
        takeNoteDraft(n)
        continue
      }
      if (next === notes) next = { ...notes }
      next[n] = draft.text
    }
    setDraftNotes(next)
  }, [episodes, marked, notes, takeNoteDraft])

  const submit = useCallback((edit: GoodEpisodeEdit): void => {
    const next = applyGoodEpisodeEdit(latest.current, edit)
    if (next === latest.current) return
    // React 还没重绘时也可能收到下一次点击，它必须基于刚刚那一笔而不是上一次渲染。
    latest.current = next
    onEdit(t.bgmId, edit)
  }, [onEdit, t.bgmId])

  // 网格上限：总集数已知就用它；未知则取 max(当前观看集, 已标最高集, 1)
  const maxN = useMemo(() => {
    if (t.totalEpisodes != null) return t.totalEpisodes
    const highest = episodes.length > 0 ? episodes[episodes.length - 1] : 0
    return Math.max(ONGOING_MIN, t.episode, highest)
  }, [t.totalEpisodes, t.episode, episodes])

  const toggle = (n: number): void => {
    const nextMarked = !latest.current.goodEpisodes.includes(n)
    if (!nextMarked) takeNoteDraft(n)
    submit({ kind: 'set-mark', episode: n, marked: nextMarked })
  }

  const clearAll = (): void => {
    for (const n of pendingNotes.current.keys()) takeNoteDraft(n)
    submit({ kind: 'clear' })
  }

  const flushNote = useCallback((n: number): void => {
    const text = takeNoteDraft(n)
    if (text !== undefined) submit({ kind: 'set-note', episode: n, text: text.trim() })
  }, [submit, takeNoteDraft])

  const scheduleNote = (n: number, text: string): void => {
    takeNoteDraft(n)
    pendingNotes.current.set(n, { text, timer: window.setTimeout(() => flushNote(n), 450) })
    setDraftNotes(prev => ({ ...prev, [n]: text }))
  }

  useEffect(() => {
    const pending = pendingNotes.current
    return () => {
      // 关闭弹窗或按 Escape 时，仍把最后一段尚未到 debounce 时间的文字送出。
      for (const n of pending.keys()) flushNote(n)
    }
  }, [flushNote])

  const title = t.titleCn || t.title

  const layout = t.episodeLayout

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="标记鉴赏神回" className="dlg ge-dlg">
        <span className="tape tl gold" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title ge-title">
          <Ic name="star" cls="ic ic-sm ge-star" />
          鉴赏神回
        </h3>
        <p className="dlg-sub">
          『{title}』
          <span className="ge-hint">轻点集号标记神回，<span className="ge-hover-hint">悬停</span><span className="ge-touch-hint">长按</span>查看章节</span>
        </p>

        <div className="ge-view-toggle">
          <button
            type="button"
            className={`ge-view-btn${view === 'all' ? ' on' : ''}`}
            onClick={() => setView('all')}
          >
            全部集数 <span className="ge-view-count">{maxN}</span>
          </button>
          <button
            type="button"
            className={`ge-view-btn${view === 'marked' ? ' on' : ''}`}
            onClick={() => setView('marked')}
          >
            <Ic name="star" cls="ic ic-sm" /> 只看鉴赏神回 <span className="ge-view-count">{episodes.length}</span>
          </button>
        </div>

        <div className="ge-body custom-scrollbar">
          {view === 'all' ? (
            <EpisodeGrid count={maxN} layout={layout} details={details} dismissTip={dismissTip}
              status={chapterError || (t.bgmId > 0 && !details ? '正在读取章节…' : undefined)}
              marked={marked} notes={notes} onToggle={toggle} />
          ) : episodes.length === 0 ? (
            <div className="ge-empty">
              <Ic name="star" cls="ic ge-empty-star" />
              <p>一集都还没标。不是我懒，是这部还没有让我停下来的那一集——先去「全部集数」点几下试试。</p>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setView('all')}>
                去点亮
              </button>
            </div>
          ) : (
            <div className="ge-list">
              {episodes.map((n) => (
                <div key={n} className="ge-row">
                  <button
                    type="button"
                    className="ge-row-ep"
                    onClick={() => toggle(n)}
                    title="取消标记这一集"
                  >
                    <Ic name="star" cls="ic ic-sm" />
                    {specialAt(layout, n) ? episodeLabel(layout, n) : n}
                  </button>
                  <input
                    className="ge-row-note"
                    value={draftNotes[n] ?? ''}
                    placeholder="这集哪里戳中你了…"
                    maxLength={GOOD_EPISODE_NOTE_MAX_LENGTH}
                    onChange={(e) => scheduleNote(n, e.target.value)}
                    onBlur={() => flushNote(n)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ge-footer">
          <div className="ge-count">
            {episodes.length > 0 ? (
              <>
                <Ic name="star" cls="ic ic-sm" /> 已标 {episodes.length} 集
              </>
            ) : (
              <span className="faint">还没标</span>
            )}
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={clearAll} disabled={episodes.length === 0}>
            <Ic name="x" cls="ic ic-sm" /> 全部撕掉
          </button>
        </div>
      </div>
    </div>
  )
}
