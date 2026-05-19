import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSystemStats } from '../hooks/useSystemStats'

interface TopBarProps {
  placeholder: string
  onSearch?: (query: string) => void
  // Optional content that replaces the left-side search input. Used by pages whose
  // workflow doesn't fit a quick-find box (e.g. File Explorer renders a title block).
  // Center "Quick Stats" and the right-side controls stay the same regardless.
  titleSlot?: JSX.Element
  /**
   * 嵌入到搜索框**内**右侧的小控件（带左边一条竖分隔线）。给 AnimeInfo 这种
   * 需要"搜索 + 类目下拉"二合一交互的页面用，避免在外面单独再加一行控件。
   *
   * 渲染位置：search 图标 + 输入框 + **slot** —— 在同一个搜索框容器里。
   * 输入框 flex-1 自动收缩，slot 用 shrink-0 保持固定尺寸。
   *
   * 体积建议：≤80px 宽（搜索框总宽 w-80 = 320px，留够 input 的可用宽度）。
   */
  searchRightSlot?: JSX.Element
}

function TopBar({ placeholder, onSearch, titleSlot, searchRightSlot }: TopBarProps): JSX.Element {
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const { diskFreeLabel, activeTasks, networkOnline, speedLabel } = useSystemStats()
  const [isDark, setIsDark] = useState(() => {
    const stored = localStorage.getItem('theme')
    if (stored) return stored === 'dark'
    return document.documentElement.classList.contains('dark')
  })

  const toggleTheme = () => {
    if (isDark) {
      document.documentElement.classList.remove('dark')
      localStorage.setItem('theme', 'light')
      setIsDark(false)
    } else {
      document.documentElement.classList.add('dark')
      localStorage.setItem('theme', 'dark')
      setIsDark(true)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && onSearch) {
      onSearch(query.trim())
    }
  }

  return (
    <header className="fixed top-0 right-0 left-64 h-16 bg-background/80 backdrop-blur-xl flex justify-between items-center px-8 z-40">
      {/* Left slot: titleSlot wins, otherwise the standard quick-find box.
          搜索框采用「分段」结构：输入分段 + 可选右侧 slot 分段。容器自身
          **不设 padding**，由各分段自己决定内边距 —— 这样 slot 里的按钮能
          占满整个分段高度（从顶到底），不会出现"中间漂浮着小胶囊"的丑况。
          分段之间用 1px 竖线分隔。

          **不能加 `overflow-hidden`** —— 否则会把 slot 里那些 `absolute` 定位
          的下拉菜单一起裁掉（菜单要往容器下面伸）。圆角改到各分段自己的边
          (`rounded-l-md` / `rounded-r-md`) 处理。 */}
      {titleSlot ?? (
        <div className="flex items-stretch bg-surface-container-highest rounded-md w-80 transition-all duration-300 focus-within:bg-surface-bright focus-within:ring-1 focus-within:ring-primary/40">
          {/* 输入分段：图标 + 输入框，自带 py-2 撑出整个搜索框的高度。 */}
          <div className="flex items-center flex-1 min-w-0 px-4 py-2">
            <span className="material-symbols-outlined text-on-surface-variant text-sm mr-2 leading-none shrink-0">
              search
            </span>
            <input
              type="text"
              placeholder={placeholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="bg-transparent border-none text-sm focus:ring-0 p-0 flex-1 min-w-0 text-on-surface placeholder:text-on-surface-variant/40 font-body outline-none"
            />
          </div>
          {/* 右侧分段：1px 竖线 + slot。slot 内的元素通过 items-stretch（默认）
              自动撑满整段高度。 */}
          {searchRightSlot && (
            <>
              <div className="w-px bg-outline-variant/25 shrink-0" />
              {searchRightSlot}
            </>
          )}
        </div>
      )}

      {/* Quick Stats */}
      <div className="flex-1 flex items-center justify-center px-8 space-x-8">
        <div className="flex flex-col items-center">
          <span className="font-label text-[9px] text-on-surface-variant/60 uppercase tracking-widest">
            Storage
          </span>
          <span className="text-[11px] font-bold text-on-surface">{diskFreeLabel}</span>
        </div>
        <div className="h-6 w-px bg-outline-variant/10" />
        <div className="flex flex-col items-center">
          <span className="font-label text-[9px] text-on-surface-variant/60 uppercase tracking-widest">
            Tasks
          </span>
          <span className={`text-[11px] font-bold ${activeTasks > 0 ? 'text-primary' : 'text-on-surface-variant/60'}`}>
            {activeTasks} ACTIVE
          </span>
        </div>
        <div className="h-6 w-px bg-outline-variant/10" />
        <div className="flex flex-col items-center">
          <span className="font-label text-[9px] text-on-surface-variant/60 uppercase tracking-widest">
            Network
          </span>
          <div className="flex items-center space-x-2">
            <div className={`w-1.5 h-1.5 rounded-full ${networkOnline ? 'bg-green-500 animate-pulse-green' : 'bg-red-500'}`} />
            <span className="text-[11px] font-bold text-on-surface">{networkOnline ? 'STABLE' : 'OFFLINE'}</span>
          </div>
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center space-x-6">
        <div className="flex items-center space-x-1">
          <span
            className="material-symbols-outlined text-primary text-sm"
            style={{ fontVariationSettings: '"FILL" 1' }}
          >
            speed
          </span>
          <span className="font-label text-xs font-bold">{speedLabel}</span>
        </div>
        <div className="flex items-center space-x-4">
          <button
            className="p-2 text-on-surface hover:bg-surface-variant/40 rounded-full transition-all"
            onClick={toggleTheme}
          >
            <span className="material-symbols-outlined text-xl leading-none">{isDark ? 'light_mode' : 'dark_mode'}</span>
          </button>
          <button
            className="p-2 text-on-surface hover:bg-surface-variant/40 rounded-full transition-all"
            onClick={() => navigate('/settings')}
          >
            <span className="material-symbols-outlined text-xl leading-none">settings</span>
          </button>
        </div>
      </div>
    </header>
  )
}

export default TopBar
