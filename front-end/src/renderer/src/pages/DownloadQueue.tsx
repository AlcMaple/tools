import TopBar from '../components/TopBar'

function ImagePlaceholder({ icon = 'movie', className = '' }: { icon?: string; className?: string }): JSX.Element {
  return (
    <div className={`bg-surface-container-high rounded-lg flex items-center justify-center ${className}`}>
      <span className="material-symbols-outlined text-on-surface-variant/30 text-2xl">{icon}</span>
    </div>
  )
}

function DownloadQueue(): JSX.Element {
  return (
    <div className="min-h-screen bg-background">
      <TopBar placeholder="Filter downloads..." />

      <main className="pt-16 px-8 py-8 custom-scrollbar overflow-y-auto">
        {/* Master control bar */}
        <div className="flex items-center justify-between mt-6 mb-8">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-on-surface">DOWNLOAD QUEUE</h1>
            <div className="flex items-center space-x-4 mt-1.5">
              <span className="text-xs font-label text-on-surface-variant/50">
                Active Tasks:{' '}
                <span className="text-primary font-bold">04</span>
              </span>
              <span className="text-on-surface-variant/20">·</span>
              <span className="text-xs font-label text-on-surface-variant/50">
                Pending:{' '}
                <span className="text-secondary font-bold">12</span>
              </span>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button className="flex items-center space-x-2 px-5 py-2.5 rounded-xl border border-outline-variant/30 text-sm font-label text-on-surface-variant hover:bg-surface-container transition-colors">
              <span className="material-symbols-outlined text-base leading-none">pause_circle</span>
              <span>Pause All</span>
            </button>
            <button className="flex items-center space-x-2 px-5 py-2.5 rounded-xl primary-gradient text-on-primary text-sm font-black tracking-wider hover:opacity-90 transition-opacity">
              <span className="material-symbols-outlined text-base leading-none">play_circle</span>
              <span>Start All</span>
            </button>
          </div>
        </div>

        {/* Download items */}
        <div className="space-y-4 mb-10">
          {/* Item 1: Active */}
          <div className="bg-surface-container rounded-xl p-5 border border-outline-variant/20 hover:border-primary/20 transition-colors">
            <div className="flex items-start space-x-4">
              <ImagePlaceholder icon="movie" className="w-16 h-20 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <h3 className="font-bold text-on-surface text-sm">Cyberpunk: Edgerunners</h3>
                    <p className="text-xs font-label text-on-surface-variant/50 mt-0.5">
                      Netflix Original · Studio Trigger
                    </p>
                  </div>
                  <div className="flex items-center space-x-3 text-right flex-shrink-0">
                    <div>
                      <p className="text-xs font-label text-primary font-bold">4.2 MB/s</p>
                      <p className="text-[10px] font-label text-on-surface-variant/40 mt-0.5">
                        14m 20s left
                      </p>
                    </div>
                    <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest transition-colors">
                      <span className="material-symbols-outlined text-on-surface-variant text-base leading-none">
                        pause
                      </span>
                    </button>
                    <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest transition-colors">
                      <span className="material-symbols-outlined text-on-surface-variant text-base leading-none">
                        close
                      </span>
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="w-full h-1.5 bg-surface-container-high rounded-full mb-3 overflow-hidden">
                  <div
                    className="h-full primary-gradient rounded-full transition-all"
                    style={{ width: '68%' }}
                  />
                </div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-label text-on-surface-variant/40">
                    68% complete
                  </span>
                  <span className="text-[10px] font-label text-on-surface-variant/40">
                    2.8 GB / 4.1 GB
                  </span>
                </div>

                {/* Episode grid */}
                <div className="flex items-center space-x-2">
                  {[
                    { ep: 'EP01', status: 'done' },
                    { ep: 'EP02', status: 'done' },
                    { ep: 'EP03', status: 'bar' },
                    { ep: 'EP04', status: 'downloading' },
                    { ep: 'EP05', status: 'pending' },
                    { ep: 'EP06', status: 'pending' }
                  ].map((item) => (
                    <div
                      key={item.ep}
                      className={`px-2 py-1 rounded text-[9px] font-label font-bold flex items-center space-x-1 ${
                        item.status === 'done'
                          ? 'bg-primary/10 text-primary'
                          : item.status === 'downloading' || item.status === 'bar'
                          ? 'bg-secondary/10 text-secondary'
                          : 'bg-surface-container-high text-on-surface-variant/40'
                      } ${item.status === 'downloading' ? 'animate-pulse' : ''}`}
                    >
                      {item.status === 'done' && (
                        <span className="material-symbols-outlined text-[10px] leading-none">
                          check
                        </span>
                      )}
                      {item.status === 'pending' && (
                        <span className="material-symbols-outlined text-[10px] leading-none">
                          hourglass_empty
                        </span>
                      )}
                      <span>{item.ep}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Item 2: Paused */}
          <div className="bg-surface-container rounded-xl p-5 border border-outline-variant/20 opacity-60 grayscale">
            <div className="flex items-start space-x-4">
              <ImagePlaceholder icon="movie" className="w-16 h-20 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <h3 className="font-bold text-on-surface text-sm">Sousou no Frieren</h3>
                    <p className="text-xs font-label text-on-surface-variant/50 mt-0.5">
                      TV Series · Madhouse
                    </p>
                  </div>
                  <div className="flex items-center space-x-3 text-right flex-shrink-0">
                    <div>
                      <p className="text-xs font-label text-on-surface-variant/50 font-bold">--</p>
                      <p className="text-[10px] font-label text-on-surface-variant/40 mt-0.5">
                        Paused
                      </p>
                    </div>
                    <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest transition-colors">
                      <span className="material-symbols-outlined text-on-surface-variant text-base leading-none">
                        play_arrow
                      </span>
                    </button>
                    <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest transition-colors">
                      <span className="material-symbols-outlined text-on-surface-variant text-base leading-none">
                        close
                      </span>
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="w-full h-1.5 bg-surface-container-high rounded-full mb-3 overflow-hidden">
                  <div
                    className="h-full bg-on-surface-variant/30 rounded-full"
                    style={{ width: '12%' }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-label text-on-surface-variant/40">
                    12% complete
                  </span>
                  <span className="text-[10px] font-label text-on-surface-variant/40">
                    0.8 GB / 6.5 GB
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Item 3: Error */}
          <div className="bg-surface-container rounded-xl p-5 border border-outline-variant/20 border-l-4 border-l-error/50">
            <div className="flex items-start space-x-4">
              <ImagePlaceholder icon="movie" className="w-16 h-20 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <h3 className="font-bold text-on-surface text-sm">Chainsaw Man</h3>
                    <p className="text-xs font-label text-on-surface-variant/50 mt-0.5">
                      TV Series · MAPPA
                    </p>
                  </div>
                  <div className="flex items-center space-x-3 text-right flex-shrink-0">
                    <div>
                      <p className="text-xs font-label text-error font-bold">Failed</p>
                      <p className="text-[10px] font-label text-on-surface-variant/40 mt-0.5">
                        Attempts: 3/5
                      </p>
                    </div>
                    <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-error/10 hover:bg-error/20 transition-colors">
                      <span className="material-symbols-outlined text-error text-base leading-none">
                        refresh
                      </span>
                    </button>
                    <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest transition-colors">
                      <span className="material-symbols-outlined text-on-surface-variant text-base leading-none">
                        close
                      </span>
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="w-full h-1.5 bg-surface-container-high rounded-full mb-3 overflow-hidden">
                  <div
                    className="h-full bg-error/60 rounded-full"
                    style={{ width: '94%' }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-label text-error/70">
                    94% — Connection error
                  </span>
                  <span className="text-[10px] font-label text-on-surface-variant/40">
                    3.8 GB / 4.0 GB
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Recently Completed */}
        <section>
          <h2 className="text-xs font-label text-on-surface-variant/50 tracking-widest uppercase mb-4">
            Recently Completed
          </h2>
          <div className="space-y-3">
            {[
              { title: 'Demon Slayer: Kimetsu no Yaiba', eps: 26, size: '12.4 GB', date: 'Today, 09:41' },
              { title: 'Attack on Titan Final Season', eps: 16, size: '8.2 GB', date: 'Yesterday, 22:15' }
            ].map((item, idx) => (
              <div
                key={idx}
                className="flex items-center space-x-4 bg-surface-container-low rounded-xl p-4 border border-outline-variant/10"
              >
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-primary text-xl leading-none">
                    check_circle
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-on-surface truncate">{item.title}</p>
                  <p className="text-xs font-label text-on-surface-variant/50 mt-0.5">
                    {item.eps} episodes · {item.size}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-xs font-label text-on-surface-variant/40">{item.date}</p>
                </div>
                <button className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors">
                  <span className="material-symbols-outlined text-on-surface-variant/40 text-base leading-none">
                    folder_open
                  </span>
                </button>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}

export default DownloadQueue
