// 通用"删除前确认"弹窗。
//
// 项目里早先用过两种风格的确认 UI：
//   1. 行内 toggle —— 点一下 trash 图标变红、setTimeout 2.5s 后失效、期间
//      再点一下才真删（MyAnime TrackRow / RecommendationView 都是这种）
//   2. 行内 "取消 / 确认删除" 一对按钮（LogView）
// 这两种都是"轻量场景"。但追番这种重对象的删除，用户更习惯"看到一个弹窗
// 明确知道自己在干嘛"——尤其涉及自定义标签、最爱值、好看集等本地数据
// 都会一起没。
//
// 所以抽个通用 modal 出来。Props 留少而准：title / description / itemName
// 三段一组就够覆盖 90% 的删除确认。danger 默认 true（红色"删除"按钮）;
// 极少数"删但不危险"场景可以 danger=false。

import { useEffect } from 'react'
import { ModalShell } from '../pages/homework/shared'

interface Props {
  /** 弹窗标题，简短动词短语，例如「移除追番」「删除推荐」。 */
  title: string
  /** 解释这次删除会发生什么的整句描述，1-3 行最佳。 */
  description: string
  /** 可选——具体被删对象的名字（番剧名 / 推荐对象名 / 文件名）。高亮显示
   *  在 description 上方让用户二次确认操作的目标对错。 */
  itemName?: string
  /** 确认按钮文案，默认「删除」。 */
  confirmText?: string
  /** danger=true（默认）→ 红色 error 系按钮；false → 中性 primary。 */
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDeleteModal({
  title, description, itemName, confirmText = '删除', danger = true, onCancel, onConfirm,
}: Props): JSX.Element {
  // ESC 关，Enter 确认 —— 快捷键照搬一般 dialog 习惯。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onConfirm])

  return (
    <ModalShell onBackdrop={onCancel}>
      <div className="flex flex-col max-w-md">
        {/* Header */}
        <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low">
          <div className="flex items-start gap-3">
            <span
              className={`material-symbols-outlined shrink-0 ${danger ? 'text-error' : 'text-primary'}`}
              style={{ fontSize: 24, fontVariationSettings: "'FILL' 1" }}
            >
              {danger ? 'warning' : 'help'}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-headline font-black text-base text-on-surface">{title}</h3>
              {itemName && (
                <p className="font-body text-xs text-on-surface-variant/85 mt-1 truncate" title={itemName}>
                  {itemName}
                </p>
              )}
            </div>
            <button
              onClick={onCancel}
              className="text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0"
            >
              <span className="material-symbols-outlined leading-none">close</span>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5">
          <p className="font-body text-sm text-on-surface-variant leading-relaxed">
            {description}
          </p>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-outline-variant/15 bg-surface-container-low flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-container-high font-label text-xs uppercase tracking-widest transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={
              danger
                ? 'px-4 py-2 rounded-lg bg-error/20 text-error border border-error/30 hover:bg-error/30 font-label text-xs font-bold uppercase tracking-widest transition-colors'
                : 'px-4 py-2 rounded-lg bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 font-label text-xs font-bold uppercase tracking-widest transition-colors'
            }
          >
            {confirmText}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
