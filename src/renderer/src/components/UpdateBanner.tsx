/**
 * 新版本提示 —— 弹窗卡片样式（不是顶部 banner 横条）。
 *
 * 复用项目通用的 `ModalShell`：
 * - 全屏暗色 backdrop，点击外部 / 按 ESC 关闭
 * - 居中卡片，宽 520px，圆角 + 阴影 + border
 * - 跟 ConfirmDeleteModal / EditBindingsModal 等其他 modal 视觉一致
 *
 * 出现条件：`downloaded`（Windows 已下载）/ `available-mac`（macOS 检出
 * 新版本）这两种用户可操作状态。其他状态在设置页"检查更新"按钮上反馈,
 * 不弹窗打扰。
 *
 * 视觉用 primary 色调（项目主题色 = 应用品牌色），跟 SCAN LOCAL FOLDERS
 * 按钮 / Sidebar 高亮项同色系。不用 tertiary（该主题 tertiary 是偏冷的灰
 * 色，跟主品牌色脱节）。
 *
 * 关闭策略：session 内不再弹（updateStore.bannerDismissed）。下次启动 / 进
 * 程重启时若仍有未装的更新，会再次出现 —— 这是有意的"温和提醒"，让忘
 * 了的用户最终被推到点更新，但不会一次烦死他。
 */

import { useEffect, useState } from 'react'
import { updateStore, shouldShowBanner, type UpdateState } from '../stores/updateStore'
import { ModalShell } from '../pages/homework/shared'

export default function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>(updateStore.getState())

  useEffect(() => {
    return updateStore.subscribe(() => setState(updateStore.getState()))
  }, [])

  // ESC 关闭、Enter 触发主操作 —— 跟 ConfirmDeleteModal 一致的键盘约定
  useEffect(() => {
    if (!shouldShowBanner(state)) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') updateStore.dismissBanner()
      else if (e.key === 'Enter') void updateStore.install()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  if (!shouldShowBanner(state)) return null

  const isMac = state.status === 'available-mac'
  const version = state.newVersion?.replace(/^v/, '') ?? '?'
  const dismiss = (): void => updateStore.dismissBanner()
  const install = (): void => { void updateStore.install() }

  return (
    <ModalShell onBackdrop={dismiss}>
      <div className="flex flex-col">
        {/* Header — primary 色图标徽章 + 标题 + 版本号 + 关闭按钮
            背景比 ModalShell body 再亮一档（highest），形成"标题锚点" */}
        <div className="px-6 py-5 border-b border-outline-variant/15 bg-surface-container-highest rounded-t-xl">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center bg-primary/15">
              <span
                className="material-symbols-outlined text-primary"
                style={{ fontSize: 22, fontVariationSettings: "'FILL' 1" }}
              >
                system_update
              </span>
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <h3 className="font-headline font-black text-base text-on-surface leading-tight">
                发现新版本
              </h3>
              <p className="font-body text-xs text-on-surface-variant mt-1.5">
                MapleTools v{version}
              </p>
            </div>
            <button
              onClick={dismiss}
              title="稍后再说（本次会话不再提醒）"
              className="text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0 -mt-1 -mr-1 w-7 h-7 rounded-md hover:bg-surface-container flex items-center justify-center"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 18 }}>close</span>
            </button>
          </div>
        </div>

        {/* Body — 描述本次更新会发生什么；mac / win 文案不同 */}
        <div className="px-6 py-6">
          <p className="font-body text-sm text-on-surface-variant leading-relaxed">
            {isMac
              ? 'macOS 因暂未做代码签名，无法在应用内静默升级。点击「前往下载」会在浏览器打开 GitHub 下载页，请下载新版 dmg 后手动安装替换当前版本。'
              : '新版本已在后台静默下载完成。点击「立即重启」将自动关闭当前应用、替换新版本、再重新启动，整个过程约 5 秒，无需任何手动操作。'}
          </p>
        </div>

        {/* Footer — 取消 / 确认按钮。padding 跟 header 对称，bg 一致 */}
        <div className="px-6 py-4 border-t border-outline-variant/15 bg-surface-container-highest rounded-b-xl flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={dismiss}
            className="px-4 py-2 rounded-lg text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-container font-label text-xs uppercase tracking-widest transition-colors"
          >
            稍后再说
          </button>
          <button
            type="button"
            onClick={install}
            autoFocus
            className="px-5 py-2 rounded-lg bg-primary/20 text-primary border border-primary/35 hover:bg-primary/30 hover:border-primary/50 font-label text-xs font-bold uppercase tracking-widest transition-colors"
          >
            {isMac ? '前往下载' : '立即重启'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
