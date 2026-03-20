import { ReactNode } from 'react'

interface TopBarProps {
  placeholder: string
  rightSlot?: ReactNode
}

function TopBar({ placeholder, rightSlot }: TopBarProps): JSX.Element {
  return (
    <header className="fixed top-0 right-0 left-64 h-16 bg-[#131313]/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 border-b border-outline-variant/20">
      {/* Search input */}
      <div className="flex items-center bg-surface-container-highest rounded-md px-4 py-2 w-96 space-x-2">
        <span className="material-symbols-outlined text-on-surface-variant/60 text-xl leading-none">
          search
        </span>
        <input
          type="text"
          placeholder={placeholder}
          className="bg-transparent text-sm text-on-surface placeholder-on-surface-variant/40 outline-none w-full font-label"
        />
      </div>

      {/* Right side actions */}
      <div className="flex items-center space-x-4">
        {rightSlot}
        <button className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors">
          <span className="material-symbols-outlined text-on-surface-variant text-xl leading-none">
            dark_mode
          </span>
        </button>
        <button className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors">
          <span className="material-symbols-outlined text-on-surface-variant text-xl leading-none">
            settings
          </span>
        </button>
        <button className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors">
          <span className="material-symbols-outlined text-on-surface-variant text-xl leading-none">
            account_circle
          </span>
        </button>
      </div>
    </header>
  )
}

export default TopBar
