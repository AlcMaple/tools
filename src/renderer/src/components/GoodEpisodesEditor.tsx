// 好看集编辑器 modal —— 点 ✨ chip 打开，让用户标 / 看 / 改这部番的好看集。
//
// 数据形态是 number[]（具体集号列表，源自用户原 PDF "好看集" 概念），点即生
// 效不走 draft —— 这个操作是"勾几集"那种细碎动作，每点一下都立即写 store 才
// 符合"勾选清单"的手感（draft 反而强迫用户多走一步"保存"，违反直觉）。
//
// ── 两种视图（顶部 toggle 切换）──────────────────────────────────────────────
//
// **全部集数（all）** —— 1..maxN 的方块网格，方块亮表示已标，再点取消。
// 适合：边追番边对照集号打勾、找具体某一集的位置。
// 总集数情况：
//   - 已知（最常见）：1 到 total
//   - 未知（连载中 / OVA）：1 到 max(episode, 已标最高集, 1)
//     "看到哪显示到哪"：episode=0（还没看）只显示 1 个方块，episode=5 显示 5 个,
//     已标过更高集号（数据导入）也撑到那里。不做"+N 扩展"按钮 —— 好看集语义
//     上是"看过的集才标"（重温 / 重看 / 暂停截图都发生在看过之后），所以上限
//     锁在"已看到 / 已标过"是合理的；想标更后面的集，看到了再回来标。
//   - 长寡番（柯南 1000+）：max-h + overflow-y-auto 撑住，没做虚拟化
//
// **仅好看集（marked）** —— 只列已标的集号，每集一个 chip，点 chip 移除。
// 适合：柯南这种 1000+ 集的番，用户只想看自己标过的几十集；不用滚长长的网格。
// 空状态：提示用户切到「全部集数」开始勾选。
//
// `episode` 仅用于决定连载中场景的网格上限（见 maxN 计算），不在 UI 上画"当前
// 集"高亮——早先版本试过给当前集加 ring-primary 轮廓做对照锚点，用户觉得
// 那个高亮反而干扰扫视（amber 已标 / 普通未标 已经够区分），就拿掉了。

import { useMemo, useState } from 'react'
import { ModalShell } from '../pages/homework/shared'
import { compressGoodEpisodes, normalizeGoodEpisodes } from '../stores/animeTrackStore'

interface Props {
  animeTitle: string
  /** 当前已标的集号集合（来自 store）。modal 内部 toggle 直接通过 onChange 写回。 */
  episodes: number[]
  /** 总集数；未知时（连载中等）走"+12 扩展"路径。 */
  totalEpisodes: number | undefined
  /** 当前观看进度，画"当前集"轮廓提示 + 决定连载中默认渲染范围。 */
  episode: number
  onChange: (next: number[]) => void
  onClose: () => void
}

type ViewMode = 'all' | 'marked'

// 连载中场景下网格至少显示 1 个方块——用户还没看过任何一集（episode=0）时
// 也得有个"门面"格子在那里，否则空网格特别突兀。1 是最克制的默认。
const ONGOING_MIN = 1

export function GoodEpisodesEditor({
  animeTitle, episodes, totalEpisodes, episode, onChange, onClose,
}: Props): JSX.Element {
  // 视图切换 —— 默认「全部集数」（最常见的"想找具体某集标记"场景）。
  // 长寡番（柯南）的用户可以手动切到「仅好看集」绕开 1000+ 方块网格。
  const [view, setView] = useState<ViewMode>('all')

  // 网格上限：
  //   - totalEpisodes 已知 → 直接用 total
  //   - 未知（连载中）→ max(当前观看集, 已标最高集, 1)
  //     "看到哪显示到哪"：episode=0 时只显示 1 个方块；用户标过更高集号（数据
  //     导入）也会撑到那里。不提供手动扩展按钮：好看集语义上必须先看过那一集
  //     才能标，所以上限锁在"已看到 / 已标过"是合理的。
  const maxN = useMemo(() => {
    if (totalEpisodes != null) return totalEpisodes
    const highestMarked = episodes.length > 0 ? episodes[episodes.length - 1] : 0
    return Math.max(ONGOING_MIN, episode, highestMarked)
  }, [totalEpisodes, episodes, episode])

  const marked = useMemo(() => new Set(episodes), [episodes])

  const toggle = (n: number): void => {
    const next = new Set(marked)
    if (next.has(n)) next.delete(n)
    else next.add(n)
    onChange(normalizeGoodEpisodes([...next]))
  }

  const clearAll = (): void => {
    if (marked.size === 0) return
    onChange([])
  }

  const compressed = compressGoodEpisodes(episodes)

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-headline font-black text-base text-on-surface flex items-center gap-2">
                <span
                  className="material-symbols-outlined text-amber-500"
                  style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
                >
                  auto_awesome
                </span>
                标记好看集
              </h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">
                {animeTitle}
              </p>
              <p className="font-body text-xs text-on-surface-variant/70 mt-2 leading-relaxed">
                点亮 = 标这集为好看，再点取消。
                <span className="text-on-surface-variant/50 ml-1">
                  参考：重温有关注点 / 重看片段 / 暂停截图。
                </span>
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0"
            >
              <span className="material-symbols-outlined leading-none">close</span>
            </button>
          </div>

          {/* 视图切换：全部集数 / 仅好看集 */}
          <div className="mt-4 inline-flex bg-surface-container rounded-md p-0.5 border border-outline-variant/15 gap-0.5">
            <ViewToggleButton
              active={view === 'all'}
              onClick={() => setView('all')}
              icon="grid_view"
              label="全部集数"
              count={maxN}
            />
            <ViewToggleButton
              active={view === 'marked'}
              onClick={() => setView('marked')}
              icon="auto_awesome"
              label="仅好看集"
              count={episodes.length}
            />
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-5">
          {view === 'all' ? (
            <GridView
              maxN={maxN}
              marked={marked}
              onToggle={toggle}
            />
          ) : (
            <MarkedView
              episodes={episodes}
              onRemove={toggle}
              onSwitchToAll={() => setView('all')}
            />
          )}
        </div>

        {/* Footer —— 当前压缩字符串预览 + 清空按钮（两个视图共用） */}
        <div className="px-5 py-3 border-t border-outline-variant/15 bg-surface-container-low flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-label text-[10px] text-on-surface-variant/45 uppercase tracking-widest mb-0.5">
              当前好看集
            </p>
            {compressed ? (
              <p className="font-mono text-xs text-amber-600 truncate" title={compressed}>
                <span className="text-amber-500/80 mr-1">✨</span>
                {compressed}
              </p>
            ) : (
              <p className="font-body text-xs text-on-surface-variant/40 italic">
                还没标 · 在「全部集数」里点亮你认为精彩的集
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={clearAll}
            disabled={marked.size === 0}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-on-surface-variant/60 hover:text-error hover:bg-error/10 font-label text-[10px] uppercase tracking-widest transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-on-surface-variant/60"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 13 }}>backspace</span>
            <span>全部清空</span>
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ── View toggle ──────────────────────────────────────────────────────────────

function ViewToggleButton({
  active, onClick, icon, label, count,
}: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
  count: number
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded font-label text-[10px] uppercase tracking-widest transition-colors flex items-center gap-1.5 ${
        active
          ? 'bg-amber-400/15 text-amber-600 font-bold'
          : 'text-on-surface-variant/55 hover:text-on-surface hover:bg-surface-container-high'
      }`}
    >
      <span
        className="material-symbols-outlined leading-none"
        style={{ fontSize: 13, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}
      >
        {icon}
      </span>
      <span>{label}</span>
      <span className={`font-mono text-[10px] ${active ? 'text-amber-600/70' : 'text-on-surface-variant/35'}`}>
        {count}
      </span>
    </button>
  )
}

// ── Grid view（全部集数）─────────────────────────────────────────────────────

function GridView({
  maxN, marked, onToggle,
}: {
  maxN: number
  marked: Set<number>
  onToggle: (n: number) => void
}): JSX.Element {
  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: 'repeat(10, minmax(0, 1fr))' }}
    >
      {Array.from({ length: maxN }, (_, i) => {
        const n = i + 1
        const isMarked = marked.has(n)
        return (
          <button
            key={n}
            type="button"
            onClick={() => onToggle(n)}
            title={isMarked ? `第 ${n} 集（已标 · 再点取消）` : `第 ${n} 集（点击标记）`}
            className={`h-9 rounded-md font-mono text-xs transition-all border ${
              isMarked
                ? 'bg-amber-400/20 text-amber-600 border-amber-400/50 font-bold hover:bg-amber-400/30'
                : 'bg-surface text-on-surface-variant/70 border-outline-variant/15 hover:bg-surface-container-high hover:text-on-surface hover:border-outline-variant/40'
            }`}
          >
            {n}
          </button>
        )
      })}
    </div>
  )
}

// ── Marked-only view（仅好看集）──────────────────────────────────────────────

/**
 * 只渲染已标的集号——长寡番（柯南标了 50 集）切到这里就只看 50 个 chip，
 * 不用滚一千多个方块。
 *
 * 每集独立一个 chip，点击移除。删除粒度精确到单集，跟"全部集数"视图里
 * "点亮已标的方块 = 取消" 是同一个 toggle 心智模型。
 *
 * 用 auto-fill grid，60px 最小宽度的 chip 让数字字体保持一致密度（不会出现
 * "1" 和 "999" chip 一大一小）；空间够多列、不够换行。
 */
function MarkedView({
  episodes, onRemove, onSwitchToAll,
}: {
  episodes: number[]
  onRemove: (n: number) => void
  onSwitchToAll: () => void
}): JSX.Element {
  if (episodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-on-surface-variant/40">
        <span
          className="material-symbols-outlined text-3xl text-amber-400/30"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          auto_awesome
        </span>
        <p className="font-body text-xs text-center max-w-[280px] leading-relaxed">
          这部番还没标好看集
        </p>
        <button
          type="button"
          onClick={onSwitchToAll}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-container border border-outline-variant/20 hover:border-primary/30 hover:bg-primary/8 text-on-surface-variant/70 hover:text-primary font-label text-[10px] uppercase tracking-widest transition-colors"
        >
          <span className="material-symbols-outlined leading-none" style={{ fontSize: 13 }}>grid_view</span>
          <span>切到「全部集数」开始勾选</span>
        </button>
      </div>
    )
  }

  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(60px, 1fr))' }}
    >
      {episodes.map(n => (
        <button
          key={n}
          type="button"
          onClick={() => onRemove(n)}
          title={`第 ${n} 集（点击移除）`}
          className="group relative h-9 rounded-md font-mono text-xs font-bold bg-amber-400/20 text-amber-600 border border-amber-400/50 hover:bg-error/15 hover:border-error/40 hover:text-error transition-all"
        >
          <span className="group-hover:opacity-0 transition-opacity">{n}</span>
          {/* hover 时显示 × 删除图标，覆盖原本的数字 */}
          <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>close</span>
          </span>
        </button>
      ))}
    </div>
  )
}
