// 用户自定义标签编辑器 modal —— 在 MyAnime TrackRow 上的 🏷 按钮触发。
//
// 业务规则（用户敲定）：
//   - BGM 标签：加追番那一刻锁定的快照，**只读**，这里只是给用户做"BGM 把
//     这部番归在哪些类里"的参考，不能改、不能删
//   - 用户自定义标签：可加可删可任意修改；下饭 / 通勤番 / 二刷预约 之类的
//     私人分类
//
// 自定义入口只在 MyAnime 这里出现 —— AnimeInfo 详情页保持"只读 BGM 元数据"
// 的角色，不掺杂用户的私人分类（否则同一部番在两处看到的 tag 不一致会很乱）。
//
// 交互：
//   - User chip：直接显示 + hover 出 × 删除（点击 chip 即移除该 tag）
//   - "+ 添加" 按钮 → 切换成 inline input，回车 / 失焦提交
//   - 重复 tag 静默忽略（store.addUserTag 已经处理）

import { useEffect, useRef, useState } from 'react'
import { ModalShell } from '../pages/homework/shared'
import { animeTrackStore, type AnimeTrack } from '../stores/animeTrackStore'

interface Props {
  track: AnimeTrack
  onClose: () => void
}

export function UserTagsEditor({ track, onClose }: Props): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  const commitAdd = (): void => {
    const trimmed = draft.trim()
    if (trimmed) animeTrackStore.addUserTag(track.bgmId, trimmed)
    setDraft('')
    setAdding(false)
  }

  const displayTitle = track.titleCn || track.title

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-headline font-black text-base text-on-surface flex items-center gap-2">
                <span
                  className="material-symbols-outlined text-primary"
                  style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
                >
                  sell
                </span>
                自定义标签
              </h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1 truncate">
                {displayTitle}
              </p>
              <p className="font-body text-xs text-on-surface-variant/70 mt-2 leading-relaxed">
                给这部番加你自己的分类（如 <span className="text-on-surface">下饭</span>、
                <span className="text-on-surface">通勤番</span>），方便在我的追番里按类型过滤。
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

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {/* BGM 标签区 —— 只读参考 */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
                BGM 标签
              </p>
              <span className="font-label text-[10px] text-on-surface-variant/35 tracking-wider">
                · 只读参考
              </span>
            </div>
            {track.bgmTags.length === 0 ? (
              <p className="font-body text-xs text-on-surface-variant/40 italic">
                这部番在 Bangumi 上还没有标签
              </p>
            ) : (
              <div className="flex items-center gap-1.5 flex-wrap">
                {track.bgmTags.map(t => (
                  <span
                    key={t}
                    title="来自 Bangumi 的标签快照（不可编辑）"
                    className="inline-flex items-center px-2.5 py-1 rounded-md bg-surface-container border border-outline-variant/20 text-on-surface-variant/80 font-label text-[11px] tracking-wider"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* 分隔线 */}
          <div className="border-t border-outline-variant/15" />

          {/* 自定义标签区 —— 可编辑 */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <p className="font-label text-[10px] text-primary uppercase tracking-widest font-bold">
                我的标签
              </p>
              <span className="font-label text-[10px] text-on-surface-variant/40 tracking-wider">
                · 点 chip 移除
              </span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {track.userTags.map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => animeTrackStore.removeUserTag(track.bgmId, t)}
                  title={`移除标签「${t}」`}
                  className="group inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary/15 border border-primary/35 text-primary hover:bg-error/15 hover:border-error/40 hover:text-error font-label text-[11px] font-bold tracking-wider transition-colors"
                >
                  <span>{t}</span>
                  <span
                    className="material-symbols-outlined leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ fontSize: 12 }}
                  >
                    close
                  </span>
                </button>
              ))}
              {adding ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={commitAdd}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitAdd()
                    if (e.key === 'Escape') { setDraft(''); setAdding(false) }
                  }}
                  placeholder="标签名…"
                  maxLength={20}
                  spellCheck={false}
                  className="w-32 px-2.5 py-1 rounded-md bg-surface border border-primary/40 outline-none focus:ring-2 focus:ring-primary/40 text-on-surface font-label text-[11px] tracking-wider"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  title="加一个新标签"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-surface border border-dashed border-outline-variant/30 hover:border-primary/40 hover:bg-primary/8 text-on-surface-variant/55 hover:text-primary font-label text-[11px] tracking-wider transition-colors"
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: 13 }}>add</span>
                  <span>添加</span>
                </button>
              )}
            </div>
            {track.userTags.length === 0 && !adding && (
              <p className="mt-3 font-body text-xs text-on-surface-variant/40 italic">
                还没加任何自定义标签 · 点上方「添加」开始
              </p>
            )}
          </section>
        </div>
      </div>
    </ModalShell>
  )
}
