// 数据清理弹窗 —— 按「最后更新日期」删除整组旧数据，用于版本更替时清掉
// 上个版本作废的作业，把数据量压在几百条量级（配合 Layer 1 渲染优化即可
// 流畅，不必上虚拟列表）。
//
// 设计要点：
//   - **手动 + 二次确认**：删除不可逆，不做定时自动删；用户按版本节奏自己点。
//   - **跨全部 4 类**（作业 / JJC / PJJC / 经典）一次清理，弹窗里分类预览数量。
//   - 日志（LogEntry）没有 updatedAt、性质不同，不参与清理。
//   - 整组删除（按 group.updatedAt）：group.updatedAt 反映该组最近活动，
//     连续 N 天没动的组视为旧数据整组删；不在活跃组里挑单条删（语义复杂）。

import { useState } from 'react'
import { ModalShell } from './shared'
import type { DefenseGroup, PjjcGroup, ClassicGroup } from './shared'

/** 返回 n 天前的本地日期串（YYYY-MM-DD，跟 todayStr 同格式，可直接字典序比较）。 */
function daysAgoStr(n: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - n)
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface CleanupData {
  homework: DefenseGroup[]
  jjc: DefenseGroup[]
  pjjc: PjjcGroup[]
  classic: ClassicGroup[]
}

const TYPE_META: ReadonlyArray<{ key: keyof CleanupData; label: string }> = [
  { key: 'homework', label: '作业查询' },
  { key: 'jjc', label: 'JJC 换防' },
  { key: 'pjjc', label: 'PJJC 换防' },
  { key: 'classic', label: '经典阵容' },
]

const PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '1 个月前', days: 30 },
  { label: '2 个月前', days: 60 },
  { label: '3 个月前', days: 90 },
]

export function CleanupModal({
  data,
  onClose,
  onConfirm,
}: {
  data: CleanupData
  onClose: () => void
  /** cutoff = YYYY-MM-DD；调用方删除各类里 updatedAt < cutoff 的组。 */
  onConfirm: (cutoff: string) => void
}): JSX.Element {
  const [cutoff, setCutoff] = useState(() => daysAgoStr(30))

  const counts = TYPE_META.map((t) => ({
    ...t,
    n: data[t.key].filter((g) => g.updatedAt < cutoff).length,
  }))
  const total = counts.reduce((s, c) => s + c.n, 0)

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-6 space-y-4">
        <div>
          <h3 className="font-headline font-black text-base text-on-surface">清理旧作业</h3>
          <p className="font-label text-[11px] text-on-surface-variant/60 mt-1 leading-relaxed">
            删除「最后更新」早于所选时间的<b className="text-on-surface-variant/80">整组</b>记录，用于版本更替时清掉旧作业。
            <span className="text-error/85"> 不可恢复</span>，建议先点同步上传备份。日志不受影响。
          </p>
        </div>

        {/* 时间范围预设 */}
        <div className="space-y-2">
          <div className="flex gap-2">
            {PRESETS.map((p) => {
              const v = daysAgoStr(p.days)
              const active = v === cutoff
              return (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => setCutoff(v)}
                  className={`flex-1 py-2 rounded-lg border font-label text-[11px] tracking-wider transition-colors ${
                    active
                      ? 'bg-primary/15 text-primary border-primary/30 font-bold'
                      : 'bg-surface-container text-on-surface-variant/70 border-outline-variant/15 hover:text-on-surface hover:bg-surface-container-high'
                  }`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
          <p className="font-label text-[10px] text-on-surface-variant/45">
            将删除 <span className="text-on-surface-variant/70">{cutoff}</span> 之前更新的记录
          </p>
        </div>

        {/* 分类预览 */}
        <div className="bg-surface-container rounded-lg p-3 space-y-1.5 border border-outline-variant/15">
          {counts.map((c) => (
            <div key={c.key} className="flex items-center justify-between text-[12px]">
              <span className="text-on-surface-variant/70">{c.label}</span>
              <span className={c.n > 0 ? 'text-error font-bold' : 'text-on-surface-variant/35'}>{c.n} 组</span>
            </div>
          ))}
          <div className="border-t border-outline-variant/15 pt-1.5 flex items-center justify-between text-[12px] font-bold">
            <span className="text-on-surface-variant">共计</span>
            <span className={total > 0 ? 'text-error' : 'text-on-surface-variant/35'}>{total} 组</span>
          </div>
        </div>

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-outline-variant/20 font-label text-sm text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(cutoff)}
            disabled={total === 0}
            className="flex-[2] py-2.5 rounded-xl bg-error text-white font-label text-sm font-bold tracking-widest hover:brightness-110 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            删除 {total} 组旧数据
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
