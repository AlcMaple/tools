// 推荐 tab 顶部「+ 新建推荐」入口的弹窗。
//
// 设计前提（用户洞察）：**推荐的番一定已经在追番列表里**——所以不需要再
// 做一遍 BGM 搜索，直接从用户的追番列表里挑就行。
//
// 流程：
//   1. 顶部输入「推荐给谁」（必填）
//   2. 中间是追番列表（带搜索过滤）
//   3. 点某一行 → 校验对象已填 → 创建推荐 → 关闭
//
// 行尾「推荐」按钮（TrackRow 上的那个 📣）走的是 QuickRecommendModal,
// 因为那里已经选定番剧，只要问对象就行。本弹窗用于「我现在想新建一条推荐,
// 让我从清单里翻翻挑一部」的场景。

import { useMemo, useRef, useState } from 'react'
import { ModalShell } from '../pages/homework/shared'
import {
  recommendationStore,
  useRecommendationList,
} from '../stores/recommendationStore'
import {
  useAnimeTrackList,
  type AnimeTrack,
} from '../stores/animeTrackStore'

interface Props {
  onClose: () => void
}

export function NewRecommendationModal({ onClose }: Props): JSX.Element {
  const tracks = useAnimeTrackList()
  // 推荐列表也订阅一份 —— 用来给每行加「已推荐过」hint，避免重复推同一部给同一个人，
  // 或者纯展示「这部已经推过 N 次」。
  const recs = useRecommendationList()
  const [toWhom, setToWhom] = useState('')
  const [query, setQuery] = useState('')
  const [toWhomMissing, setToWhomMissing] = useState(false)
  const toWhomRef = useRef<HTMLInputElement>(null)

  // 每部番的"已推荐给谁"集合，给行末做提示用
  const recipientsByBgmId = useMemo(() => {
    const m = new Map<number, string[]>()
    for (const r of recs) {
      const arr = m.get(r.bgmId) ?? []
      arr.push(r.toWhom)
      m.set(r.bgmId, arr)
    }
    return m
  }, [recs])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tracks
    return tracks.filter(t => {
      const hay = [t.title, t.titleCn ?? ''].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [tracks, query])

  const pick = (t: AnimeTrack): void => {
    if (!toWhom.trim()) {
      setToWhomMissing(true)
      toWhomRef.current?.focus()
      return
    }
    recommendationStore.create({
      bgmId: t.bgmId,
      title: t.title,
      titleCn: t.titleCn,
      cover: t.cover,
      toWhom: toWhom.trim(),
    })
    onClose()
  }

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex flex-col max-h-[75vh]">
        {/* Header */}
        <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-headline font-black text-base text-on-surface">新建推荐</h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">
                从追番列表里挑一部 + 写推荐对象
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

        {/* 推荐对象 + 番剧过滤 */}
        <div className="p-5 pb-3 shrink-0 space-y-3">
          <div>
            <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1 block">
              推荐给谁
            </label>
            <input
              ref={toWhomRef}
              type="text"
              value={toWhom}
              onChange={e => {
                setToWhom(e.target.value)
                if (e.target.value.trim()) setToWhomMissing(false)
              }}
              placeholder="例：Bob / 妹妹 / 群里"
              maxLength={40}
              autoFocus
              spellCheck={false}
              className={`w-full bg-surface-container border rounded-lg px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 transition-all ${
                toWhomMissing
                  ? 'border-error/60 ring-error/40 focus:ring-error/50 focus:border-error/60'
                  : 'border-outline-variant/20 focus:ring-primary/40 focus:border-primary/30'
              }`}
            />
            {toWhomMissing && (
              <p className="mt-1 font-label text-[10px] text-error">先填写"推荐给谁"再点番剧</p>
            )}
          </div>

          <div>
            <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1 block">
              推荐的番剧（从追番列表中挑选）
            </label>
            <div className="flex items-center bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 gap-2 focus-within:border-primary/40 transition-colors">
              <span className="material-symbols-outlined text-on-surface-variant/40 text-base leading-none">search</span>
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="过滤追番列表..."
                spellCheck={false}
                className="flex-1 bg-transparent outline-none text-sm text-on-surface placeholder:text-on-surface-variant/35"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="text-on-surface-variant/40 hover:text-on-surface"
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>close</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 追番列表 */}
        <div className="overflow-y-auto flex-1 px-3 pb-5 min-h-[160px]">
          {tracks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-on-surface-variant/40">
              <span className="material-symbols-outlined text-3xl">bookmarks</span>
              <p className="font-label text-xs">追番列表是空的，先去 BGM 详情页加几部番</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-on-surface-variant/40">
              <span className="material-symbols-outlined text-3xl">search_off</span>
              <p className="font-label text-xs">没匹配到，换个关键词</p>
            </div>
          ) : (
            <ul className="space-y-1.5 px-2 pt-1">
              {filtered.map(t => {
                const display = t.titleCn || t.title
                const native = t.titleCn && t.title && t.title !== t.titleCn ? t.title : ''
                const prev = recipientsByBgmId.get(t.bgmId) ?? []
                return (
                  <li key={t.bgmId}>
                    <button
                      onClick={() => pick(t)}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-surface hover:bg-surface-container-highest border border-outline-variant/10 hover:border-primary/30 text-left transition-all group"
                    >
                      {/* 封面缩略 */}
                      <div className="w-9 h-12 shrink-0 bg-surface-container rounded overflow-hidden flex items-center justify-center">
                        {t.cover ? (
                          <img src={t.cover} alt={display} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <span className="material-symbols-outlined text-on-surface-variant/30 text-base">image</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-on-surface text-sm group-hover:text-primary transition-colors truncate">
                          {display}
                        </p>
                        {native && (
                          <p className="font-label text-[10px] text-on-surface-variant/45 truncate mt-0.5">
                            {native}
                          </p>
                        )}
                        {prev.length > 0 && (
                          <p className="font-label text-[10px] text-on-surface-variant/55 mt-0.5">
                            已推荐过：{prev.join('、')}
                          </p>
                        )}
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant/20 group-hover:text-primary/60 transition-colors text-base shrink-0">
                        arrow_forward
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </ModalShell>
  )
}
