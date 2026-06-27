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
import { ModalShell, ModalButton } from '../pages/homework/shared'
import { useCover } from '../hooks/useCover'
import coverFallback from '../assets/cover-fallback.png'

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
 * 匹配维度：标题 / 中文标题 / 推荐方（fromWhom）/ 推荐对方（toWhom）。
 * 大小写不敏感子串匹配。空 query 视为全命中，让"没搜索"时列表完整。
 */
export function matchesRecommendation(rec: Recommendation, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [rec.title, rec.titleCn ?? '', rec.fromWhom, rec.toWhom, rec.recommendReason ?? '']
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
  /** 按推荐人（toWhom）过滤，OR 语义：空数组 = 不过滤；非空 = 命中任一即显示。 */
  recipients?: string[]
}

export function RecommendationView({ filter, query = '', recipients = [] }: Props): JSX.Element {
  const all = useRecommendationList()
  // 三个小弹窗各记一个 recId（null = 没在进行中）：拒绝写原因 / 接受写备注 / 编辑推荐方对方。
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  // 列表显示：query → status filter → 推荐人 filter（OR），最后 createdAt 倒序（最新在顶）。
  const visible = useMemo(() => {
    const byQ = all.filter(r => matchesRecommendation(r, query))
    const byStatus = filter === 'all' ? byQ : byQ.filter(r => r.status === filter)
    const list = recipients.length === 0
      ? byStatus
      : byStatus.filter(r => recipients.includes(r.toWhom))
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [all, filter, query, recipients])

  const rejectingRec = rejectingId ? all.find(r => r.id === rejectingId) ?? null : null
  const acceptingRec = acceptingId ? all.find(r => r.id === acceptingId) ?? null : null
  const editingRec = editingId ? all.find(r => r.id === editingId) ?? null : null

  return (
    <div className="px-4 md:px-8 py-6 space-y-3">
      {/* 推荐列表 —— 始终单列、整页左对齐铺满（不收 max-w，跟追番列表一致）。 */}
      {all.length === 0 ? (
        <EmptyAll />
      ) : visible.length === 0 ? (
        <EmptyFiltered hasQuery={!!query.trim()} />
      ) : (
        visible.map(r => (
          <RecRow
            key={r.id}
            rec={r}
            onAcceptClick={() => setAcceptingId(r.id)}
            onRejectClick={() => setRejectingId(r.id)}
            onUnmark={() => recommendationStore.markPending(r.id)}
            onEditClick={() => setEditingId(r.id)}
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

      {/* Accept note modal —— 备注可选 */}
      {acceptingRec && (
        <AcceptReasonModal
          rec={acceptingRec}
          onCancel={() => setAcceptingId(null)}
          onConfirm={(reason) => {
            recommendationStore.markAccepted(acceptingRec.id, reason)
            setAcceptingId(null)
          }}
        />
      )}

      {/* Edit fromWhom / toWhom modal —— 主要给老数据补「推荐方」 */}
      {editingRec && (
        <EditPersonModal
          rec={editingRec}
          onCancel={() => setEditingId(null)}
          onConfirm={(fromWhom, toWhom, recommendReason) => {
            recommendationStore.edit(editingRec.id, { fromWhom, toWhom, recommendReason })
            setEditingId(null)
          }}
        />
      )}
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

function RecRow({
  rec, onAcceptClick, onRejectClick, onUnmark, onEditClick, onDelete,
}: {
  rec: Recommendation
  onAcceptClick: () => void
  onRejectClick: () => void
  onUnmark: () => void
  onEditClick: () => void
  onDelete: () => void
}): JSX.Element {
  const meta = REC_STATUS_META[rec.status]
  const display = rec.titleCn || rec.title
  const native = rec.titleCn && rec.title && rec.title !== rec.titleCn ? rec.title : ''
  const [confirmDelete, setConfirmDelete] = useState(false)
  // 封面走 useCover，key 用 bgmId —— 跟动画 TrackRow 同 key 同尺寸（默认 480），
  // 直接命中动画那边已本地化的 {bgmId}.480.jpg，不再对着 lain.bgm.tv 重拉一遍。
  const coverSrc = useCover(String(rec.bgmId), rec.cover)
  const hasNotes =
    !!rec.recommendReason ||
    (rec.status === 'rejected' && !!rec.failReason) ||
    (rec.status === 'accepted' && !!rec.successReason)
  return (
    // 社交贴式布局：上半区「封面 + 标题/状态」并排，下半区「推荐理由 / 备注」整宽
    // 平铺。这样多出来的文字横跨封面下方，不会像并排布局那样在封面右侧堆一摞、
    // 把封面抻高或在封面下留一大块空白。没有备注时只剩上半区，卡片自然紧凑。
    <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-3 sm:p-4">
      {/* 上半区 */}
      <div className="flex gap-3 sm:gap-4 items-start">
        {/* Cover —— 固定 3:4 海报缩略图，定宽不拉伸；窄窗（平板/手机）缩到 72px。 */}
        <div className="w-[72px] sm:w-[88px] shrink-0 aspect-[3/4] bg-surface-container-high overflow-hidden rounded-lg relative">
          {rec.cover ? (
            <img
              src={coverSrc || coverFallback}
              alt={display}
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
              decoding="async"
              onError={(e) => {
                const img = e.currentTarget
                if (img.src !== coverFallback) {
                  img.onerror = null
                  img.src = coverFallback
                }
              }}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-on-surface-variant/20">
              <span className="material-symbols-outlined text-xl">image</span>
            </div>
          )}
        </div>

        {/* 标题 / 元信息 / 状态操作 */}
        <div className="flex-1 min-w-0 flex flex-col gap-2">
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
                onClick={onEditClick}
                title="编辑推荐方 / 对方 / 理由"
                className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px] leading-none">edit</span>
              </button>
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

          {/* 推荐信息独占一整行 —— 移出标题左栏，不再被右上角操作图标挤窄，
              这样「X 推荐给 Y · 日期」能整条落在一行里。 */}
          <p className="font-label text-[11px] text-on-surface-variant/55 tracking-wide">
            {/* 推荐方是后加字段:老数据无 fromWhom 时退回旧文案"推荐给 X"。 */}
            {rec.fromWhom && (
              <>
                <span className="text-on-surface/80 font-bold">{rec.fromWhom}</span>
                <span className="mx-1">推荐给</span>
              </>
            )}
            {!rec.fromWhom && '推荐给 '}
            <span className="text-on-surface/80 font-bold">{rec.toWhom}</span>
            {/* 分隔点 + 日期不可断开，整体放不下才换行。 */}
            <span className="whitespace-nowrap">
              <span className="mx-1.5 text-on-surface-variant/30">·</span>
              {formatDate(rec.createdAt)}
            </span>
          </p>

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
                  onClick={onAcceptClick}
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

            {rec.status === 'accepted' && (
              <button
                onClick={onAcceptClick}
                title={rec.successReason ? '改成功备注' : '加成功备注'}
                className="px-2.5 py-1 rounded-md border border-outline-variant/30 hover:border-secondary/40 hover:bg-secondary/10 text-on-surface-variant/70 hover:text-secondary font-label text-[10px] uppercase tracking-widest transition-colors"
              >
                {rec.successReason ? '改备注' : '加备注'}
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
        </div>
      </div>

      {/* 下半区：推荐理由 / 备注 —— 整宽平铺，横跨封面下方，填掉封面下的空白。
          三者都没有时整块不渲染，卡片保持紧凑。 */}
      {hasNotes && (
        <div className="mt-3 space-y-2">
          {/* 推荐理由（推荐方写的，与状态无关）—— 中性底色，区别于下面对方侧的结果备注。 */}
          {rec.recommendReason && (
            <p className="font-label text-[11px] leading-relaxed text-on-surface-variant/85 bg-surface-container-high border border-outline-variant/20 rounded-md px-3 py-2 whitespace-pre-wrap break-words">
              <span className="text-on-surface-variant/45 mr-1">推荐理由：</span>
              {rec.recommendReason}
            </p>
          )}

          {/* 失败原因（仅 rejected 显示） */}
          {rec.status === 'rejected' && rec.failReason && (
            <p className="font-label text-[11px] leading-relaxed text-error/85 bg-error/[0.05] border border-error/15 rounded-md px-3 py-2 whitespace-pre-wrap break-words">
              <span className="text-error/55 mr-1">原因：</span>
              {rec.failReason}
            </p>
          )}

          {/* 成功原因（仅 accepted 且填了备注时显示）—— 跟失败原因同款式，换 secondary 色 */}
          {rec.status === 'accepted' && rec.successReason && (
            <p className="font-label text-[11px] leading-relaxed text-secondary/85 bg-secondary/[0.05] border border-secondary/15 rounded-md px-3 py-2 whitespace-pre-wrap break-words">
              <span className="text-secondary/55 mr-1">成功原因：</span>
              {rec.successReason}
            </p>
          )}
        </div>
      )}
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
            {rec.fromWhom ? `${rec.fromWhom} 推荐给 ${rec.toWhom}` : `推荐给 ${rec.toWhom}`} · {rec.titleCn || rec.title}
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
          <ModalButton variant="cancel" onClick={onCancel}>取消</ModalButton>
          <ModalButton variant="danger" icon="cancel" onClick={() => onConfirm(reason.trim())} disabled={!canConfirm}>
            确认拒绝
          </ModalButton>
        </div>
      </div>
    </ModalShell>
  )
}

// ── Accept note modal ────────────────────────────────────────────────────────

// 标记接受时弹的小窗：写「为什么这次推荐成功了」。跟拒绝窗对称，但**备注可选**
// —— 推荐成功本身就是好结果，不强制写理由；写了能帮日后总结"什么样的番好推"。
function AcceptReasonModal({
  rec, onCancel, onConfirm,
}: {
  rec: Recommendation
  onCancel: () => void
  onConfirm: (reason: string) => void
}): JSX.Element {
  const [reason, setReason] = useState(rec.successReason ?? '')
  // 已是 accepted（点「改备注」进来）时标题用"改成功备注"，否则是首次标记接受。
  const isEditingNote = rec.status === 'accepted'
  return (
    <ModalShell onBackdrop={onCancel}>
      <div className="p-6 space-y-4">
        <div>
          <h3 className="font-headline font-black text-base text-on-surface">
            {isEditingNote ? '成功备注' : '推荐成功'}
          </h3>
          <p className="font-label text-[10px] text-on-surface-variant/55 mt-1 uppercase tracking-widest">
            {rec.fromWhom ? `${rec.fromWhom} 推荐给 ${rec.toWhom}` : `推荐给 ${rec.toWhom}`} · {rec.titleCn || rec.title}
          </p>
        </div>
        <div>
          <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1 block">
            成功原因（可选）
          </label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="例：对方正好在找新番 / 喜欢这个题材 / 被画风吸引"
            autoFocus
            spellCheck={false}
            rows={3}
            className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-secondary/40 focus:border-secondary/30 transition-all resize-none"
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <ModalButton variant="cancel" onClick={onCancel}>取消</ModalButton>
          <ModalButton variant="secondary" icon="check_circle" onClick={() => onConfirm(reason.trim())}>
            {isEditingNote ? '保存备注' : '确认接受'}
          </ModalButton>
        </div>
      </div>
    </ModalShell>
  )
}

// ── Edit fromWhom / toWhom modal ─────────────────────────────────────────────

// 编辑推荐方 / 推荐对方。主要给老数据补「推荐方」（normalize 给空串、展示退回
// "推荐给 X"），也能纠正笔误。推荐对方必填（空串会被 normalize 丢弃），推荐方可空。
function EditPersonModal({
  rec, onCancel, onConfirm,
}: {
  rec: Recommendation
  onCancel: () => void
  onConfirm: (fromWhom: string, toWhom: string, recommendReason: string) => void
}): JSX.Element {
  const [fromWhom, setFromWhom] = useState(rec.fromWhom)
  const [toWhom, setToWhom] = useState(rec.toWhom)
  const [reason, setReason] = useState(rec.recommendReason ?? '')
  const canConfirm = toWhom.trim().length > 0
  return (
    <ModalShell onBackdrop={onCancel}>
      <div className="p-6 space-y-4">
        <div>
          <h3 className="font-headline font-black text-base text-on-surface">编辑推荐</h3>
          <p className="font-label text-[10px] text-on-surface-variant/55 mt-1 uppercase tracking-widest">
            {rec.titleCn || rec.title}
          </p>
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1 block">
              谁推荐的
            </label>
            <input
              type="text"
              value={fromWhom}
              onChange={e => setFromWhom(e.target.value)}
              placeholder="例：我 / 妹妹 / 群友老王"
              maxLength={40}
              autoFocus
              spellCheck={false}
              className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
            />
          </div>
          <div className="flex-1">
            <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1 block">
              推荐给谁
            </label>
            <input
              type="text"
              value={toWhom}
              onChange={e => setToWhom(e.target.value)}
              placeholder="例：Bob / 妹妹 / 群里"
              maxLength={40}
              spellCheck={false}
              className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
            />
          </div>
        </div>
        <div>
          <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1 block">
            推荐理由（可选）
          </label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="推荐方写：为什么推荐这部给 TA（可留空）"
            maxLength={200}
            rows={2}
            spellCheck={false}
            className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all resize-none"
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <ModalButton variant="cancel" onClick={onCancel}>取消</ModalButton>
          <ModalButton variant="primary" icon="check" onClick={() => onConfirm(fromWhom.trim(), toWhom.trim(), reason.trim())} disabled={!canConfirm}>
            保存
          </ModalButton>
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
