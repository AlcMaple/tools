// 行尾"推荐"按钮触发的极简弹窗 —— 番剧已经选定（caller 传入的 track），
// 只问「推荐给谁」一个字段，确认即创建。
//
// 跟从追番列表挑选的 PickAndRecommendModal 区分开：那个用于"我突然想新建
// 一条推荐，让我从清单里挑"的场景；这个用于"我正在追番列表看着某一行,
// 顺手推给谁"的场景，后者更高频。

import { useState } from 'react'
import { ModalShell } from '../pages/homework/shared'
import { recommendationStore } from '../stores/recommendationStore'
import type { AnimeTrack } from '../stores/animeTrackStore'

interface Props {
  /** 已经选定的番剧 —— 直接复用它的 bgmId / title / titleCn / cover 创建推荐。 */
  track: AnimeTrack
  onClose: () => void
  /** 创建成功后回调（可选，用于 toast / 跳转推荐 tab 等）。 */
  onCreated?: () => void
}

export function QuickRecommendModal({ track, onClose, onCreated }: Props): JSX.Element {
  const [toWhom, setToWhom] = useState('')
  const canSubmit = toWhom.trim().length > 0
  const display = track.titleCn || track.title

  const submit = (): void => {
    if (!canSubmit) return
    recommendationStore.create({
      bgmId: track.bgmId,
      title: track.title,
      titleCn: track.titleCn,
      cover: track.cover,
      toWhom: toWhom.trim(),
    })
    onCreated?.()
    onClose()
  }

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
            <span
              className="material-symbols-outlined text-primary text-[20px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              campaign
            </span>
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-black tracking-tight">新建推荐</h3>
            <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label truncate" title={display}>
              「{display}」
            </p>
          </div>
        </div>

        {/* 推荐对象输入 */}
        <div>
          <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1.5 block">
            推荐给谁
          </label>
          <input
            type="text"
            value={toWhom}
            onChange={e => setToWhom(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && canSubmit) submit() }}
            placeholder="例：Bob / 妹妹 / 群里"
            maxLength={40}
            autoFocus
            spellCheck={false}
            className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="flex-1 py-2.5 rounded-lg border border-primary/40 bg-primary/10 text-primary font-bold text-sm hover:bg-primary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-base leading-none">campaign</span>
            创建推荐
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
