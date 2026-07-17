// 顶部导航栏 —— 网页版的全局导航。app 是侧边栏（桌面应用的语言），网页的惯例是顶栏，
// 所以这里不照搬 app 的侧边栏，走顶栏。
//
// 右侧账号区：未登录 = 「登录 / 注册」按钮；已登录 = 用户名 chip → 下拉（设置 / 退出）。
// chip 按内容伸缩、只给下限 min-w（刚够下拉里「退出登录」放下），下拉 `w-full` 自动跟 chip 同宽
// （见 AI_GUIDELINES「UI/样式」：浮层宽度对齐触发器）。用户名上限 12 字符 → chip 最宽 ≈205px。
import { useEffect, useRef, useState } from 'react'
import { auth, useAuth } from './auth'
import { Icon } from './Icon'
import type { Route } from './router'

export function Nav({
  route,
  onNavigate,
  onLogin,
}: {
  route: Route
  onNavigate: (r: Route) => void
  onLogin: () => void
}): JSX.Element {
  return (
    // gap 跟着品牌字走：sm 以下「MapleTools」隐藏，只剩 20px 的枫叶，再留 28px 的空当
    // 会让 logo 和「番剧周历」中间凭空空出一大块（NavLink 自己还有 px-3）。
    <nav className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-outline-variant/10 bg-surface-container-lowest px-4 sm:gap-7 md:px-6">
      <button
        type="button"
        onClick={() => onNavigate('calendar')}
        className="flex shrink-0 items-center gap-2"
      >
        <MapleMark />
        <span className="hidden text-[15px] font-extrabold tracking-tight text-on-surface sm:block">
          MapleTools
        </span>
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-1">
        <NavLink active={route === 'calendar'} onClick={() => onNavigate('calendar')}>
          番剧周历
        </NavLink>
        <NavLink active={route === 'tracks'} onClick={() => onNavigate('tracks')}>
          我的追番
        </NavLink>
      </div>

      <UserArea onLogin={onLogin} onNavigate={onNavigate} />
    </nav>
  )
}

function MapleMark(): JSX.Element {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" className="text-primary" aria-hidden>
      <path d="M12 2 9.7 6.6l-2.3-.7.6 2.4-3.4-1 1.6 3-1.9.5 3.4 2.7-.7 1.6 4-.5-.3 4.4h1.6l-.3-4.4 4 .5-.7-1.6 3.4-2.7-1.9-.5 1.6-3-3.4 1 .6-2.4-2.3.7z" />
    </svg>
  )
}

function NavLink({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-3 py-[18px] text-[13.5px] font-semibold transition-colors ${
        active
          ? 'text-primary after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-t after:bg-primary'
          : 'text-on-surface-variant/65 hover:text-on-surface'
      }`}
    >
      {children}
    </button>
  )
}

function UserArea({
  onLogin,
  onNavigate,
}: {
  onLogin: () => void
  onNavigate: (r: Route) => void
}): JSX.Element {
  const { user, ready } = useAuth()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // 登录态未探明前占位，避免闪一下登录按钮
  if (!ready) return <div className="h-8 w-[108px] shrink-0" />

  if (!user) {
    return (
      <button
        type="button"
        onClick={onLogin}
        className="flex shrink-0 items-center gap-1.5 rounded border border-outline-variant/40 bg-surface-container-high px-3 py-1.5 font-label text-[11px] uppercase tracking-widest text-on-surface-variant transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
      >
        <Icon name="person" size={14} />
        <span>登录 / 注册</span>
      </button>
    )
  }

  return (
    <div ref={box} className="relative inline-block shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-[108px] items-center gap-2 rounded border border-outline-variant/25 bg-surface-container px-2.5 py-1.5 text-xs font-semibold text-on-surface transition-colors hover:border-primary/35"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
          {user.username}
        </span>
        <Icon
          name="expand_more"
          size={13}
          className={`shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-45 w-full rounded-md border border-outline-variant/30 bg-surface-container-low p-1 shadow-2xl">
          <MenuItem
            icon="settings"
            onClick={() => {
              setOpen(false)
              onNavigate('settings')
            }}
          >
            设置
          </MenuItem>
          <MenuItem
            icon="logout"
            danger
            onClick={() => {
              setOpen(false)
              void auth.logout().then(() => onNavigate('calendar'))
            }}
          >
            退出登录
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  danger,
  onClick,
  children,
}: {
  icon: 'settings' | 'logout'
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left text-[13px] font-medium text-on-surface-variant transition-colors ${
        danger ? 'hover:bg-error/10 hover:text-error' : 'hover:bg-on-surface/5 hover:text-on-surface'
      }`}
    >
      <Icon name={icon} size={15} />
      {children}
    </button>
  )
}
