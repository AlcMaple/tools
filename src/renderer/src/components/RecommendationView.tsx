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
 * 推荐的搜索匹配 —— 跟追番列表的搜索框共用同一个 query state（MyAnime 持有）。
 * 匹配维度：标题 / 中文标题 / 推荐对象（toWhom）。大小写不敏感子串匹配。
 * 空 query 视为全命中，让"没搜索"时列表完整。
 */
export function matchesRecommendation(rec: Recommendation, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [rec.title, rec.titleCn ?? '', rec.toWhom]
    .join(' ')
    .toLowerCase()
    .includes(q)
}

/**
 * 给 MyAnime 用的 helper：按 filter 计数。filter chips 和 visible 列表
 * 共享这个统计，避免在两个地方分别 filter 一次。
 *
 * 传入的 `all` 应当是**已经按 query 过滤过**的列表 —— 这样徽章数字反映
 * 搜索收窄后的范围，跟追番 tab 的 counts 语义一致（见 MyAnime）。
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
  /** 跟追番列表共用的搜索 query（标题 / 推荐对象）。 */
  query?: string
}

export function RecommendationView({ filter, query = '' }: Props): JSX.Element {
  const all = useRecommendationList()
  // 拒绝时的小弹窗：记录当前要拒绝的 recId（null = 没在拒绝中）
  const [rejectingId, setRejectingId] = useState<string | null>(null)

  // 列表显示：先按 query 过滤，再按 status filter，最后 createdAt 倒序（最新在顶）。
  const visible = useMemo(() => {
    const byQ = all.filter(r => matchesRecommendation(r, query))
    const list = filter === 'all' ? byQ : byQ.filter(r => r.status === filter)
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [all, filter, query])

  const rejectingRec = rejectingId ? all.find(r => r.id === rejectingId) ?? null : null

  return (
    <div className="px-8 py-6 space-y-3">
      {/* 推荐列表 */}
      {all.length === 0 ? (
        <EmptyAll />
      ) : visible.length === 0 ? (
        <EmptyFiltered hasQuery={!!query.trim()} />
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
    <div className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden flex min-h-[140px]">
      {/* Cover —— 跟 TrackRow 完全一致：`min-h-[140px]` 统一卡片高度下限（取自
          动画卡片三行内容的高度），封面 `absolute inset-0 object-cover` 铺满
          卡片高度。推荐卡片内容比追番少，但靠这条 floor 拉到同样的 140px，跟
          动画卡片等高 —— 切换 tab 不会因为推荐内容少而变矮、产生"挪动"感。 */}
      <div className="w-[88px] shrink-0 bg-surface-container-high overflow-hidden rounded-l-xl relative">
        {rec.cover ? (
          <img
            src={rec.cover}
            alt={display}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-on-surface-variant/20">
            <span className="material-symbols-outlined text-xl">image</span>
          </div>
        )}
      </div>

      {/* Body —— padding / gap 跟 TrackRow 对齐（p-3 / gap-2）。`justify-between`
          两端对齐：首行（标题块）贴顶、跟动画卡片标题位置一致；末行（状态+操作）
          贴底；卡片被 floor 拉到 140px 的富余高度均分到中间，而不是 justify-center
          把内容全挤中间、顶部和底部各留一片空白。 */}
      <div className="flex-1 p-3 min-w-0 flex flex-col gap-2 justify-between">
        {/* Title row —— 字号跟 TrackRow 对齐：标题 text-base(16px)，副标题 text-xs，
            推荐信息 text-[11px]，避免推荐卡片整体看起来比追番卡片"小一号"。 */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-on-surface truncate leading-tight" title={display}>
              {display}
            </h3>
            {native && (
              <p className="text-xs text-on-surface-variant/60 truncate mt-0.5" title={native}>
                {native}
              </p>
            )}
            <p className="font-label text-[11px] text-on-surface-variant/55 mt-1.5 tracking-wide">
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

function EmptyFiltered({ hasQuery }: { hasQuery: boolean }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-2 text-on-surface-variant/30">
      <span className="material-symbols-outlined text-4xl">{hasQuery ? 'search_off' : 'filter_alt_off'}</span>
      <p className="font-label text-xs">{hasQuery ? '没有匹配搜索的推荐' : '这个分类下还没有推荐'}</p>
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
