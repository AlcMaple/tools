import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSystemStats } from '../hooks/useSystemStats'

interface TopBarProps {
  placeholder: string
  onSearch?: (query: string) => void
}

function TopBar({ placeholder, onSearch }: TopBarProps): JSX.Element {
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const { diskFreeLabel, activeTasks, networkOnline, speedLabel } = useSystemStats()

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && query.trim() && onSearch) {
      onSearch(query.trim())
    }
  }

  return (
    <header className="fixed top-0 right-0 left-64 h-16 bg-[#131313]/80 backdrop-blur-xl flex justify-between items-center px-8 z-40">
      {/* Search input */}
      <div className="flex items-center bg-surface-container-highest rounded-md px-4 py-2 w-80 transition-all duration-300 focus-within:bg-surface-bright focus-within:ring-1 focus-within:ring-primary/40">
        <span className="material-symbols-outlined text-on-surface-variant text-sm mr-2 leading-none">
          search
        </span>
        <input
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="bg-transparent border-none text-sm focus:ring-0 p-0 w-full text-on-surface placeholder:text-on-surface-variant/40 font-body outline-none"
        />
      </div>

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
          <button className="p-2 text-[#e2e2e2] hover:bg-[#353535]/40 rounded-full transition-all">
            <span className="material-symbols-outlined text-xl leading-none">dark_mode</span>
          </button>
          <button
            className="p-2 text-[#e2e2e2] hover:bg-[#353535]/40 rounded-full transition-all"
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
