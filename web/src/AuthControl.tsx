// Hero 右上角登录入口。未登录 = 「登录 / 注册」按钮；已登录 = 用户名 chip + 退出。
// 登录态未探明前（首次 /me 未回）渲染空占位，避免闪一下登录按钮。
import { auth, useAuth } from './auth'
import { Icon } from './Icon'

export function AuthControl({ onOpen }: { onOpen: () => void }): JSX.Element {
  const { user, ready } = useAuth()

  if (!ready) return <div className="h-8" />

  if (!user) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center gap-1.5 rounded border border-outline-variant/40 bg-surface-container-high px-3 py-1.5 font-label text-[11px] uppercase tracking-widest text-on-surface-variant transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
      >
        <Icon name="person" size={14} />
        <span>登录 / 注册</span>
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 rounded border border-outline-variant/25 bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
        {user.username}
      </span>
      <button
        type="button"
        onClick={() => void auth.logout()}
        title="退出登录"
        className="flex h-8 w-8 items-center justify-center rounded border border-outline-variant/20 bg-surface-container-high text-on-surface-variant/70 transition-colors hover:border-error/40 hover:bg-error/8 hover:text-error"
      >
        <Icon name="logout" size={15} />
      </button>
    </div>
  )
}
