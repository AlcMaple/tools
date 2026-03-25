import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

function Settings(): JSX.Element {
  const navigate = useNavigate()
  const [localPath, setLocalPath] = useState('C:/Users/Archivist/Documents/BiuProjects/Anime')
  const [remotePath, setRemotePath] = useState('ssh://obsidian-node-01/mnt/media/archivist/biu-mirror')
  const [searchCache, setSearchCache] = useState(true)

  return (
    <div className="min-h-full bg-surface">
      {/* Header */}
      <header className="fixed top-0 right-0 left-64 h-16 z-40 bg-[#131313]/80 backdrop-blur-xl border-b border-white/5 flex items-center justify-between px-8">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-variant/40 rounded-full transition-colors"
          >
            <span className="material-symbols-outlined text-xl leading-none">arrow_back</span>
          </button>
          <span className="h-4 w-px bg-white/10" />
          <span className="font-headline font-bold text-sm text-on-surface tracking-widest uppercase">
            Dashboard
          </span>
          <span className="h-4 w-px bg-white/10" />
          <span className="font-label text-xs text-on-surface-variant/60 tracking-widest uppercase">
            System Preferences
          </span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-on-surface-variant/60">
            <span className="material-symbols-outlined text-sm leading-none">storage</span>
            <span className="font-label text-[10px] tracking-widest">942 GB FREE</span>
          </div>
          <div className="flex items-center gap-2 text-on-surface-variant/60">
            <span className="material-symbols-outlined text-sm leading-none">speed</span>
            <span className="font-label text-[10px] tracking-widest">3 ACTIVE</span>
          </div>
          <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/5 transition-colors text-on-surface">
            <span className="material-symbols-outlined text-xl leading-none">wifi_tethering</span>
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="pt-32 pb-20 px-12 max-w-7xl mx-auto">
        {/* Page Title */}
        <section className="mb-16">
          <h1 className="font-headline font-black text-6xl tracking-tighter text-on-surface mb-2">
            SETTINGS<span className="text-primary">.</span>
          </h1>
          <p className="font-label text-sm uppercase tracking-[0.3em] text-on-surface-variant/40 max-w-xl">
            Configure the core operational parameters for the digital archivist environment.
            Changes take effect immediately upon persistence.
          </p>
        </section>

        <div className="grid grid-cols-12 gap-10 items-start">
          {/* Left Column */}
          <section className="col-span-12 lg:col-span-7 space-y-8">
            {/* Biu Sync Configuration */}
            <div className="bg-surface-container p-8 rounded-xl border border-white/5">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary">folder_shared</span>
                  <h2 className="font-headline font-bold text-xl uppercase tracking-tight">
                    Biu Sync Configuration
                  </h2>
                </div>
                <div className="flex items-center gap-2 px-3 py-1 bg-primary/10 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  <span className="font-label text-[10px] text-primary font-bold tracking-widest uppercase">
                    Required
                  </span>
                </div>
              </div>
              <div className="space-y-6">
                {/* Local Path */}
                <div className="space-y-2">
                  <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant/60">
                    Local Project Path
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-surface-container-highest rounded-md px-4 py-3 flex items-center gap-3 focus-within:bg-surface-bright transition-all">
                      <span className="material-symbols-outlined text-on-surface-variant/40 text-sm leading-none">
                        computer
                      </span>
                      <input
                        type="text"
                        value={localPath}
                        onChange={(e) => setLocalPath(e.target.value)}
                        className="bg-transparent border-none focus:ring-0 w-full text-sm font-label text-on-surface placeholder-on-surface-variant/30 outline-none"
                      />
                    </div>
                    <button className="bg-surface-container-high hover:bg-surface-bright px-4 rounded-md transition-colors flex items-center justify-center">
                      <span className="material-symbols-outlined text-sm leading-none">folder_open</span>
                    </button>
                  </div>
                </div>
                {/* Remote Path */}
                <div className="space-y-2">
                  <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant/60">
                    Remote Sync Path
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-surface-container-highest rounded-md px-4 py-3 flex items-center gap-3 focus-within:bg-surface-bright transition-all">
                      <span className="material-symbols-outlined text-on-surface-variant/40 text-sm leading-none">
                        cloud_sync
                      </span>
                      <input
                        type="text"
                        value={remotePath}
                        onChange={(e) => setRemotePath(e.target.value)}
                        className="bg-transparent border-none focus:ring-0 w-full text-sm font-label text-on-surface placeholder-on-surface-variant/30 outline-none"
                      />
                    </div>
                    <button className="bg-surface-container-high hover:bg-surface-bright px-4 rounded-md transition-colors flex items-center justify-center">
                      <span className="material-symbols-outlined text-sm leading-none">link</span>
                    </button>
                  </div>
                </div>
                <p className="font-body text-xs text-on-surface-variant/40 leading-relaxed border-t border-white/5 pt-4">
                  These paths define the architectural bridge between your local workstation and the
                  remote Biu project server. Automated hash verification will be performed during
                  each synchronization cycle.
                </p>
              </div>
            </div>

            {/* Search Preferences */}
            <div className="bg-surface-container p-8 rounded-xl border border-white/5">
              <div className="flex items-center gap-3 mb-8">
                <span className="material-symbols-outlined text-primary">search_insights</span>
                <h2 className="font-headline font-bold text-xl uppercase tracking-tight">
                  Search Preferences
                </h2>
              </div>
              <div className="flex items-start justify-between gap-8 p-6 bg-surface-container-low rounded-lg border border-white/5">
                <div className="space-y-1">
                  <h3 className="font-headline font-bold text-sm uppercase tracking-wider">
                    Enable Search Cache
                  </h3>
                  <p className="text-xs text-on-surface-variant/50 leading-relaxed">
                    When enabled, previously searched titles will load instantly from local storage.
                    Disable to force fresh metadata scraping from original indexers.
                  </p>
                </div>
                {/* Toggle */}
                <label className="relative inline-flex items-center cursor-pointer mt-1 flex-shrink-0">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={searchCache}
                    onChange={(e) => setSearchCache(e.target.checked)}
                  />
                  <div className="w-12 h-6 bg-surface-container-highest rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-secondary" />
                </label>
              </div>
            </div>
          </section>

          {/* Right Column */}
          <aside className="col-span-12 lg:col-span-5 space-y-6">
            {/* Configuration Summary */}
            <div className="bg-surface-variant/70 p-8 rounded-xl border border-white/10 shadow-2xl">
              <h4 className="font-headline font-bold text-lg mb-6 uppercase tracking-wider border-b border-white/5 pb-4">
                Configuration Summary
              </h4>
              <div className="space-y-4 mb-10">
                <div className="flex justify-between items-center">
                  <span className="font-label text-xs text-on-surface-variant/50 uppercase tracking-widest">
                    Environment
                  </span>
                  <span className="font-label text-xs text-on-surface uppercase">Production</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-label text-xs text-on-surface-variant/50 uppercase tracking-widest">
                    Node ID
                  </span>
                  <span className="font-label text-xs text-on-surface uppercase">ARC-8821-X</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-label text-xs text-on-surface-variant/50 uppercase tracking-widest">
                    Last Sync
                  </span>
                  <span className="font-label text-xs text-on-surface uppercase">4 MIN AGO</span>
                </div>
                <div className="w-full h-px bg-white/5 my-2" />
                <div className="flex justify-between items-center">
                  <span className="font-label text-xs text-on-surface-variant/50 uppercase tracking-widest">
                    Storage Status
                  </span>
                  <span className="font-label text-xs text-secondary uppercase">Optimal</span>
                </div>
              </div>
              <div className="space-y-3">
                <button className="w-full py-4 bg-gradient-to-r from-primary to-primary-container rounded-full text-on-primary-container font-headline font-black text-sm uppercase tracking-[0.2em] shadow-[0_10px_30px_rgba(240,145,153,0.2)] hover:scale-[1.02] active:scale-100 transition-all">
                  Save Changes
                </button>
                <button className="w-full py-4 text-primary font-headline font-bold text-sm uppercase tracking-[0.2em] hover:bg-surface-variant/40 rounded-full transition-all">
                  Reset to Default
                </button>
              </div>
            </div>

            {/* Change History */}
            <div className="p-8 bg-surface-container rounded-xl border border-white/5">
              <div className="flex items-center gap-3 mb-6">
                <span className="material-symbols-outlined text-secondary">history</span>
                <h2 className="font-headline font-bold text-sm uppercase tracking-widest">
                  Change History
                </h2>
              </div>
              <ul className="space-y-4">
                {[
                  { text: 'Updated project_path via auto-detect', time: 'OCT 24, 14:21:05' },
                  { text: 'Search cache enabled', time: 'OCT 23, 09:12:44' },
                  { text: 'Remote sync path validated', time: 'OCT 22, 11:45:12' },
                ].map((entry, i) => (
                  <li key={i} className="flex items-start gap-4 group">
                    <div className="mt-1 w-1.5 h-1.5 rounded-full bg-primary/40 group-hover:bg-primary transition-colors flex-shrink-0" />
                    <div className="space-y-1">
                      <p className="font-label text-[11px] text-on-surface/80 uppercase leading-tight">
                        {entry.text}
                      </p>
                      <p className="font-label text-[9px] text-on-surface-variant/40 uppercase tracking-tighter">
                        {entry.time}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>

      {/* Background watermark */}
      <div className="fixed bottom-0 right-0 p-8 pointer-events-none select-none">
        <p className="font-label text-[150px] font-black text-white/[0.02] leading-none tracking-tighter uppercase">
          Config
        </p>
      </div>
    </div>
  )
}

export default Settings
