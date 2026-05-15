// 推荐管理视图 —— 嵌在「我的追番」页面的 tab 里，跟「追番列表」并列。
//
// 结构上跟追番列表一致：过滤 chips + 新建按钮放在 MyAnime 的 sticky header
// 里（由 MyAnime 持有 filter state 渲染），本组件只负责列表 body 部分。这样
// tab 切换时整体布局保持稳定，仅 body 内容变化。
//
// 每条推荐展示：封面 + 标题 + 推荐给谁 + 状态徽章 + 操作按钮。操作语义：
//   - 待回应 → 标记接受 / 标记拒绝（拒绝弹小弹窗写原因）
//   - 已接受 → 改回待回应（误标修正）
//   - 已拒绝 → 改原因 / 改回待回应
// 删除随时都能点（小垃圾桶图标）。

import { useMemo, useState } from 'react'
import {
  recommendationStore,
  useRecommendationList,
  type Recommendation,
  type RecommendationStatus,
} from '../stores/recommendationStore'
import { ModalShell } from '../pages/homework/shared'

export type RecFilterKey = 'all' | RecommendationStatus

export const REC_STATUS_META: Record<RecommendationStatus, {
  label: string
  icon: string
  color: string
  tint: string
  border: string
}> = {
  pending: {
    label: '待回应',
    icon: 'schedule',
    color: 'text-on-surface-variant',
    tint: 'bg-on-surface-variant/10',
    border: 'border-on-surface-variant/30',
  },
  accepted: {
    label: '已接受',
    icon: 'check_circle',
    color: 'text-secondary',
    tint: 'bg-secondary/10',
    border: 'border-secondary/30',
  },
  rejected: {
    label: '已拒绝',
    icon: 'cancel',
    color: 'text-error',
    tint: 'bg-error/10',
    border: 'border-error/30',
  },
}

/**
 * 给 MyAnime 用的 helper：按 filter 计数。filter chips 和 visible 列表
 * 共享这个统计，避免在两个地方分别 filter 一次。
 */
export function countRecsByStatus(all: Recommendation[]): Record<RecFilterKey, number> {
  const c: Record<RecFilterKey, number> = { all: 0, pending: 0, accepted: 0, rejected: 0 }
  for (const r of all) {
    c.all++
    c[r.status]++
  }
  return c
}

interface Props {
  /** 由 MyAnime 持有，决定当前展示哪个分类。 */
  filter: RecFilterKey
}

export function RecommendationView({ filter }: Props): JSX.Element {
  const all = useRecommendationList()
  // 拒绝时的小弹窗：记录当前要拒绝的 recId（null = 没在拒绝中）
  const [rejectingId, setRejectingId] = useState<string | null>(null)

  // 列表显示：按 createdAt 倒序（最新推荐的在顶）
  const visible = useMemo(() => {
    const list = filter === 'all' ? all : all.filter(r => r.status === filter)
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [all, filter])

  const rejectingRec = rejectingId ? all.find(r => r.id === rejectingId) ?? null : null

  return (
    <div className="px-8 py-6 space-y-3">
      {/* 推荐列表 */}
      {all.length === 0 ? (
        <EmptyAll />
      ) : visible.length === 0 ? (
        <EmptyFiltered />
      ) : (
        visible.map(r => (
          <RecRow
            key={r.id}
            rec={r}
            onAccept={() => recommendationStore.markAccepted(r.id)}
            onRejectClick={() => setRejectingId(r.id)}
            onUnmark={() => recommendationStore.markPending(r.id)}
            onDelete={() => recommendationStore.delete(r.id)}
          />
        ))
      )}

      {/* Reject reason modal */}
      {rejectingRec && (
        <RejectReasonModal
          rec={rejectingRec}
          onCancel={() => setRejectingId(null)}
          onConfirm={(reason) => {
            recommendationStore.markRejected(rejectingRec.id, reason)
            setRejectingId(null)
          }}
        />
      )}
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

function RecRow({
  rec, onAccept, onRejectClick, onUnmark, onDelete,
}: {
  rec: Recommendation
  onAccept: () => void
  onRejectClick: () => void
  onUnmark: () => void
  onDelete: () => void
}): JSX.Element {
  const meta = REC_STATUS_META[rec.status]
  const display = rec.titleCn || rec.title
  const native = rec.titleCn && rec.title && rec.title !== rec.titleCn ? rec.title : ''
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden flex">
      {/* Cover */}
      <div className="w-[72px] shrink-0 bg-surface-container-high">
        {rec.cover ? (
          <img
            src={rec.cover}
            alt={display}
            className="w-full aspect-[2/3] object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full aspect-[2/3] flex items-center justify-center text-on-surface-variant/20">
            <span className="material-symbols-outlined text-xl">image</span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 p-4 min-w-0 flex flex-col gap-2.5">
        {/* Title row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-on-surface truncate" title={display}>
              {display}
            </h3>
            {native && (
              <p className="text-[11px] text-on-surface-variant/60 truncate mt-0.5" title={native}>
                {native}
              </p>
            )}
            <p className="font-label text-[10px] text-on-surface-variant/55 mt-1.5 tracking-wide">
              推荐给 <span className="text-on-surface/80 font-bold">{rec.toWhom}</span>
              <span className="mx-1.5 text-on-surface-variant/30">·</span>
              {formatDate(rec.createdAt)}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <a
              href={`https://bgm.tv/subject/${rec.bgmId}`}
              target="_blank"
              rel="noreferrer"
              title="在 Bangumi 上查看"
              className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px] leading-none">open_in_new</span>
            </a>
            <button
              onClick={() => {
                if (confirmDelete) {
                  onDelete()
                } else {
                  setConfirmDelete(true)
                  setTimeout(() => setConfirmDelete(false), 2500)
                }
              }}
              title={confirmDelete ? '再点一次确认删除' : '删除这条推荐'}
              className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                confirmDelete
                  ? 'text-error bg-error/15'
                  : 'text-on-surface-variant/50 hover:text-error hover:bg-error/10'
              }`}
            >
              <span
                className="material-symbols-outlined text-[16px] leading-none"
                style={{ fontVariationSettings: confirmDelete ? "'FILL' 1" : "'FILL' 0" }}
              >
                {confirmDelete ? 'delete_forever' : 'delete'}
              </span>
            </button>
          </div>
        </div>

        {/* Status + 操作 */}
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border font-label text-[10px] uppercase tracking-widest ${meta.tint} ${meta.color} ${meta.border} font-bold`}
          >
            <span
              className="material-symbols-outlined leading-none"
              style={{ fontSize: 12, fontVariationSettings: "'FILL' 1" }}
            >
              {meta.icon}
            </span>
            {meta.label}
          </span>

          {rec.status === 'pending' && (
            <>
              <button
                onClick={onAccept}
                className="px-2.5 py-1 rounded-md border border-secondary/30 hover:border-secondary/50 hover:bg-secondary/10 text-secondary font-label text-[10px] uppercase tracking-widest transition-colors"
              >
                标记接受
              </button>
              <button
                onClick={onRejectClick}
                className="px-2.5 py-1 rounded-md border border-error/30 hover:border-error/50 hover:bg-error/10 text-error font-label text-[10px] uppercase tracking-widest transition-colors"
              >
                标记拒绝
              </button>
            </>
          )}

          {(rec.status === 'accepted' || rec.status === 'rejected') && (
            <button
              onClick={onUnmark}
              className="px-2.5 py-1 rounded-md border border-outline-variant/30 hover:border-on-surface-variant/40 hover:bg-surface-container-high text-on-surface-variant/70 hover:text-on-surface font-label text-[10px] uppercase tracking-widest transition-colors"
            >
              改回待回应
            </button>
          )}

          {rec.status === 'rejected' && (
            <button
              onClick={onRejectClick}
              title="改原因"
              className="px-2.5 py-1 rounded-md border border-outline-variant/30 hover:border-on-surface-variant/40 hover:bg-surface-container-high text-on-surface-variant/70 hover:text-on-surface font-label text-[10px] uppercase tracking-widest transition-colors"
            >
              改原因
            </button>
          )}
        </div>

        {/* 失败原因（仅 rejected 显示） */}
        {rec.status === 'rejected' && rec.failReason && (
          <p className="font-label text-[11px] text-error/85 bg-error/[0.05] border border-error/15 rounded-md px-3 py-2">
            <span className="text-error/55 mr-1">原因：</span>
            {rec.failReason}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Reject reason modal ──────────────────────────────────────────────────────

function RejectReasonModal({
  rec, onCancel, onConfirm,
}: {
  rec: Recommendation
  onCancel: () => void
  onConfirm: (reason: string) => void
}): JSX.Element {
  const [reason, setReason] = useState(rec.failReason ?? '')
  const canConfirm = reason.trim().length > 0
  return (
    <ModalShell onBackdrop={onCancel}>
      <div className="p-6 space-y-4">
        <div>
          <h3 className="font-headline font-black text-base text-on-surface">
            {rec.status === 'rejected' ? '改原因' : '推荐失败'}
          </h3>
          <p className="font-label text-[10px] text-on-surface-variant/55 mt-1 uppercase tracking-widest">
            推荐给 {rec.toWhom} · {rec.titleCn || rec.title}
          </p>
        </div>
        <div>
          <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1 block">
            原因（必填）
          </label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="例：对方不喜欢日漫 / 节奏太慢 / 题材不感兴趣"
            autoFocus
            spellCheck={false}
            rows={3}
            className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-error/40 focus:border-error/30 transition-all resize-none"
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-lg border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(reason.trim())}
            disabled={!canConfirm}
            className="flex-1 py-2.5 rounded-lg border border-error/40 bg-error/10 text-error font-bold text-sm hover:bg-error/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-base leading-none">cancel</span>
            确认拒绝
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ── Empty states ─────────────────────────────────────────────────────────────

function EmptyAll(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-32 gap-6 text-on-surface-variant/30">
      <span className="material-symbols-outlined text-6xl">campaign</span>
      <div className="text-center max-w-md">
        <p className="font-headline text-base text-on-surface/60 font-bold mb-1">还没有推荐记录</p>
        <p className="font-body text-xs leading-relaxed">
          在追番列表行尾点 <span className="material-symbols-outlined align-text-bottom text-on-surface/60" style={{ fontSize: 14 }}>campaign</span> 推荐图标，或者点右上的「+ 新建推荐」按钮，记录你把哪部番推荐给了谁。
        </p>
      </div>
    </div>
  )
}

function EmptyFiltered(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-2 text-on-surface-variant/30">
      <span className="material-symbols-outlined text-4xl">filter_alt_off</span>
      <p className="font-label text-xs">这个分类下还没有推荐</p>
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  } catch {
    return iso
  }
}
