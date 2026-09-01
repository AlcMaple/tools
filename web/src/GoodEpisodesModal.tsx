// 好看集弹窗 —— 参考桌面端 GoodEpisodesEditor，网页版重画成手帐纸片风格。
//
// 语义跟桌面端对齐（都是踩过坑定下来的，别改）：
//   - 数据是具体集号数组，不是计数；点即生效，不走草稿 —— 「勾清单」这种细碎动作每点一下
//     立刻写回才符合手感。
//   - 总集数未知（连载中）时网格上限取 max(当前观看集, 已标最高集, 1)，看到哪显示到哪，
//     不给「+N 扩展」按钮 —— 好看集语义上必须先看过那一集才能标。
//   - 取消标记会连带清掉那一集的备注，不留孤儿。
//
// 备注编辑：不用悬浮气泡（试过，锚定位置在弹窗里飘、点哪都可能溢出，还挡住内容）。
// 备注采用短 debounce 而不是只等失焦：切换集数或关闭弹窗前也要保住最后一笔，
// 同时避免每个字符都单独发请求；跟「全部集数」的网格点亮/取消仍是两个模式。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Track, TrackPatch } from './api'
import { normalizeGoodEpisodes } from './api'
import { Ic } from './SketchIcon'

const ONGOING_MIN = 1

type ViewMode = 'all' | 'marked'

export function GoodEpisodesModal({
  t,
  onPatch,
  onClose,
}: {
  t: Track
  onPatch: (bgmId: number, p: TrackPatch) => void
  onClose: () => void
}): JSX.Element {
  const [view, setView] = useState<ViewMode>('all')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const episodes = t.goodEpisodes
  const notes = t.goodEpisodeNotes
  const marked = useMemo(() => new Set(episodes), [episodes])
  const [draftNotes, setDraftNotes] = useState<Record<number, string>>(notes)
  const noteTimers = useRef(new Map<number, number>())
  const pendingNotes = useRef(new Map<number, string>())
  const notesRef = useRef(notes)

  useEffect(() => {
    notesRef.current = notes
    // 权威快照回来时，保留 debounce 窗口内还没提交的文字，避免实时编辑被旧快照盖掉。
    setDraftNotes(() => {
      const next = { ...notes }
      for (const [episode, raw] of pendingNotes.current) next[episode] = raw
      return next
    })
  }, [notes])

  // 网格上限：总集数已知就用它；未知则取 max(当前观看集, 已标最高集, 1)
  const maxN = useMemo(() => {
    if (t.totalEpisodes != null) return t.totalEpisodes
    const highest = episodes.length > 0 ? episodes[episodes.length - 1] : 0
    return Math.max(ONGOING_MIN, t.episode, highest)
  }, [t.totalEpisodes, t.episode, episodes])

  const toggle = (n: number): void => {
    const next = new Set(marked)
    if (next.has(n)) next.delete(n)
    else next.add(n)
    onPatch(t.bgmId, { goodEpisodes: normalizeGoodEpisodes([...next]) })
  }

  const clearAll = (): void => {
    if (episodes.length === 0) return
    onPatch(t.bgmId, { goodEpisodes: [], goodEpisodeNotes: {} })
  }

  // trim 后为空就删掉这一集的备注，不留孤儿。跟现值一样就不发请求。
  const commitNote = (n: number, raw: string): void => {
    const trimmed = raw.trim()
    pendingNotes.current.delete(n)
    if ((notesRef.current[n] ?? '') === trimmed) return
    const nextNotes = { ...notesRef.current }
    if (trimmed) nextNotes[n] = trimmed
    else delete nextNotes[n]
    notesRef.current = nextNotes
    onPatch(t.bgmId, { goodEpisodeNotes: nextNotes })
  }

  // 输入时延迟一点提交，既能做到不按回车也会保存，又不会每个字符都打一次接口。
  const scheduleNote = (n: number, raw: string): void => {
    setDraftNotes((prev) => ({ ...prev, [n]: raw }))
    pendingNotes.current.set(n, raw)
    const previous = noteTimers.current.get(n)
    if (previous !== undefined) window.clearTimeout(previous)
    const timer = window.setTimeout(() => {
      noteTimers.current.delete(n)
      commitNote(n, raw)
    }, 450)
    noteTimers.current.set(n, timer)
  }

  const flushNote = (n: number, raw: string): void => {
    const timer = noteTimers.current.get(n)
    if (timer !== undefined) window.clearTimeout(timer)
    noteTimers.current.delete(n)
    pendingNotes.current.delete(n)
    commitNote(n, raw)
  }

  useEffect(() => {
    const timers = noteTimers.current
    const pending = pendingNotes.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
      // 关闭弹窗或按 Escape 时，仍把最后一段尚未到 debounce 时间的文字送出。
      for (const [n, raw] of pending) commitNote(n, raw)
      pending.clear()
    }
  }, [t.bgmId])

  const title = t.titleCn || t.title

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="标记好看集" className="dlg ge-dlg">
        <span className="tape tl gold" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title ge-title">
          <Ic name="star" cls="ic ic-sm ge-star" />
          好看集
        </h3>
        <p className="dlg-sub">
          『{title}』里我随手点亮的那几集。点一下亮起来，再点一下就灭掉——标准是我定的，不解释。
          <span className="ge-hint">已标的集切到「只看好看集」能写句吐槽，不写也没关系。</span>
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
            <Ic name="star" cls="ic ic-sm" /> 只看好看集 <span className="ge-view-count">{episodes.length}</span>
          </button>
        </div>

        <div className="ge-body custom-scrollbar">
          {view === 'all' ? (
            <div className="ge-grid">
              {Array.from({ length: maxN }, (_, i) => i + 1).map((n) => {
                const isMarked = marked.has(n)
                const note = isMarked ? notes[n] : undefined
                return (
                  <button
                    key={n}
                    type="button"
                    className={`ge-ep${isMarked ? ' on' : ''}`}
                    onClick={() => toggle(n)}
                    title={note}
                  >
                    {n}
                    {note && <span className="ge-ep-dot" />}
                  </button>
                )
              })}
            </div>
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
                    {n}
                  </button>
                  <input
                    className="ge-row-note"
                    value={draftNotes[n] ?? ''}
                    placeholder="这集哪里戳中你了…"
                    maxLength={60}
                    onChange={(e) => scheduleNote(n, e.target.value)}
                    onBlur={(e) => flushNote(n, e.currentTarget.value)}
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
