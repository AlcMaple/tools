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
      {/* 直接撑满 ModalShell 的 520px —— 不再叠 max-w-md，否则右侧会留 70+ px
          空白，跟其他用 ModalShell 的弹窗（GoodEpisodesEditor / UserTagsEditor
          / SearchSourceModal 等）视觉宽度也一致。 */}
      <div className="flex flex-col">
        {/* Header —— 警告图标 + 标题 + 对象名 + 关闭。
            bg surface-container-highest 比 ModalShell 本身（high）再亮一档,
            做"标题区"视觉锚点；header 跟下面 body 之间用 border 分隔。 */}
        <div className="px-6 py-5 border-b border-outline-variant/15 bg-surface-container-highest rounded-t-xl">
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-full shrink-0 flex items-center justify-center ${
                danger ? 'bg-error/15' : 'bg-primary/15'
              }`}
            >
              <span
                className={`material-symbols-outlined ${danger ? 'text-error' : 'text-primary'}`}
                style={{ fontSize: 22, fontVariationSettings: "'FILL' 1" }}
              >
                {danger ? 'warning' : 'help'}
              </span>
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <h3 className="font-headline font-black text-base text-on-surface leading-tight">
                {title}
              </h3>
              {itemName && (
                <p
                  className="font-body text-xs text-on-surface-variant mt-1.5 truncate"
                  title={itemName}
                >
                  {itemName}
                </p>
              )}
            </div>
            <button
              onClick={onCancel}
              className="text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0 -mt-1 -mr-1 w-7 h-7 rounded-md hover:bg-surface-container flex items-center justify-center"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 18 }}>close</span>
            </button>
          </div>
        </div>

        {/* Body —— 描述文字。padding 上下 6 给文字呼吸，左侧对齐到 header 的
            "图标盒子 + gap" 不需要做（描述是独立段落，左对齐 padding 即可）。 */}
        <div className="px-6 py-6">
          <p className="font-body text-sm text-on-surface-variant leading-relaxed">
            {description}
          </p>
        </div>

        {/* Footer —— 取消 / 确认按钮。padding 跟 header 对称，
            bg 也跟 header 一致 highest，形成"上下视觉锚点夹一段透明 body"。 */}
        <div className="px-6 py-4 border-t border-outline-variant/15 bg-surface-container-highest rounded-b-xl flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-container font-label text-xs uppercase tracking-widest transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={
              danger
                ? 'px-5 py-2 rounded-lg bg-error/20 text-error border border-error/35 hover:bg-error/30 hover:border-error/50 font-label text-xs font-bold uppercase tracking-widest transition-colors'
                : 'px-5 py-2 rounded-lg bg-primary/20 text-primary border border-primary/35 hover:bg-primary/30 hover:border-primary/50 font-label text-xs font-bold uppercase tracking-widest transition-colors'
            }
          >
            {confirmText}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
