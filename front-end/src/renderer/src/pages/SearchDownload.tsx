import { useState } from 'react'
import TopBar from '../components/TopBar'

const resultCards = [
  { title: 'Cyberpunk: Edgerunners', episodes: 10, year: 2022, studio: 'Trigger' },
  { title: 'Neon Genesis Evangelion', episodes: 26, year: 1995, studio: 'Gainax' },
  { title: 'Chainsaw Man', episodes: 12, year: 2022, studio: 'MAPPA' },
  { title: 'Sousou no Frieren', episodes: 28, year: 2023, studio: 'Madhouse' }
]

function ImagePlaceholder({ icon = 'image', className = '' }: { icon?: string; className?: string }): JSX.Element {
  return (
    <div className={`bg-surface-container-high flex items-center justify-center ${className}`}>
      <span className="material-symbols-outlined text-on-surface-variant/30 text-4xl">{icon}</span>
    </div>
  )
}

function SearchDownload(): JSX.Element {
  const [captchaVisible, setCaptchaVisible] = useState(true)
  const [source, setSource] = useState('Xifan')
  const [searchQuery, setSearchQuery] = useState('')
  const [captchaInput, setCaptchaInput] = useState('')

  return (
    <div className="min-h-screen bg-background">
      <TopBar placeholder="Quick find archives..." />

      <main className="pt-16 px-8 py-8 custom-scrollbar overflow-y-auto">
        {/* Hero Section */}
        <section className="mt-10 mb-12">
          <p className="font-label text-xs text-primary/70 tracking-[0.3em] uppercase mb-3">
            Multisource Downloader
          </p>
          <h1 className="text-7xl font-black leading-none tracking-tighter text-on-surface mb-4">
            INDEX THE{' '}
            <span className="text-primary">MULTIVERSE</span>
          </h1>
          <p className="text-on-surface-variant/60 text-sm max-w-lg font-label">
            Search and retrieve anime from multiple sources simultaneously. Automated pipeline from
            search to archive.
          </p>
        </section>

        {/* Search Bar */}
        <section className="mb-10">
          <div className="flex items-center gap-3 max-w-3xl">
            <div className="flex-1 flex items-center bg-surface-container-highest rounded-xl px-5 py-3.5 space-x-3 border border-outline-variant/30 focus-within:border-primary/40 transition-colors">
              <span className="material-symbols-outlined text-primary text-xl leading-none">
                travel_explore
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Enter anime title or keyword..."
                className="flex-1 bg-transparent text-on-surface placeholder-on-surface-variant/40 outline-none text-sm font-label"
              />
            </div>

            {/* Source selector */}
            <div className="relative">
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="appearance-none bg-surface-container-highest border border-outline-variant/30 text-on-surface text-sm font-label rounded-xl px-4 py-3.5 pr-8 outline-none cursor-pointer hover:border-primary/40 transition-colors"
              >
                <option value="Xifan">Xifan</option>
                <option value="Girigiri">Girigiri</option>
                <option value="Nyaa.si">Nyaa.si</option>
                <option value="AnimeBytes">AnimeBytes</option>
              </select>
              <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-sm pointer-events-none leading-none">
                expand_more
              </span>
            </div>

            <button className="primary-gradient text-on-primary font-black text-sm tracking-widest px-7 py-3.5 rounded-xl hover:opacity-90 transition-opacity flex items-center space-x-2">
              <span className="material-symbols-outlined text-base leading-none">bolt</span>
              <span>INITIALIZE</span>
            </button>
          </div>
        </section>

        {/* Results Grid */}
        <section>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-xs font-label text-on-surface-variant/50 tracking-widest uppercase">
              Search Results — 4 entries found
            </h2>
            <div className="flex items-center space-x-2 text-xs font-label text-on-surface-variant/40">
              <span className="material-symbols-outlined text-sm leading-none">filter_list</span>
              <span>Sort by relevance</span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4">
            {resultCards.map((card, idx) => (
              <div
                key={idx}
                className="group relative bg-surface-container rounded-xl overflow-hidden border border-outline-variant/20 hover:border-primary/30 transition-all duration-300 cursor-pointer"
              >
                {/* Poster */}
                <div className="aspect-[2/3] relative overflow-hidden">
                  <ImagePlaceholder icon="movie" className="w-full h-full" />
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">
                    <button className="w-full primary-gradient text-on-primary text-xs font-black tracking-widest py-2.5 rounded-lg mb-2 flex items-center justify-center space-x-1.5">
                      <span className="material-symbols-outlined text-sm leading-none">
                        download
                      </span>
                      <span>DOWNLOAD</span>
                    </button>
                    <button className="w-full bg-surface-container-highest/80 text-on-surface text-xs font-label py-2 rounded-lg flex items-center justify-center space-x-1.5">
                      <span className="material-symbols-outlined text-sm leading-none">info</span>
                      <span>Details</span>
                    </button>
                  </div>
                </div>

                {/* Card footer */}
                <div className="p-3">
                  <h3 className="text-sm font-bold text-on-surface truncate mb-1">{card.title}</h3>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-label text-on-surface-variant/50">
                      {card.year} · {card.studio}
                    </span>
                    <span className="text-xs font-label text-primary/70">{card.episodes} eps</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* CAPTCHA Modal */}
      {captchaVisible && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-surface-container-lowest/40 backdrop-blur-sm">
          <div className="glass-effect w-full max-w-md rounded-xl p-8 border border-outline-variant/30">
            {/* Header */}
            <div className="flex items-start justify-between mb-6">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-primary text-xl leading-none">
                    security
                  </span>
                </div>
                <div>
                  <h3 className="text-sm font-black tracking-wider text-on-surface">
                    CRAWLER VERIFICATION
                  </h3>
                  <p className="text-[10px] font-label text-on-surface-variant/50 mt-0.5">
                    Source: Xifan ACG
                  </p>
                </div>
              </div>
              <button
                onClick={() => setCaptchaVisible(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors text-on-surface-variant/60 hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-xl leading-none">close</span>
              </button>
            </div>

            {/* CAPTCHA image placeholder */}
            <div className="aspect-video rounded-lg overflow-hidden mb-4 relative bg-surface-container-high">
              <div className="w-full h-full flex items-center justify-center">
                <div className="text-center">
                  <span className="material-symbols-outlined text-on-surface-variant/20 text-5xl block mb-2">
                    image
                  </span>
                  <p className="text-xs font-label text-on-surface-variant/30">
                    CAPTCHA image area
                  </p>
                </div>
              </div>
              {/* Grayscale overlay hint */}
              <div className="absolute inset-0 bg-gradient-to-br from-surface-variant/10 to-transparent pointer-events-none" />
            </div>

            {/* Refresh */}
            <button className="flex items-center space-x-1.5 text-xs font-label text-on-surface-variant/50 hover:text-primary transition-colors mb-5">
              <span className="material-symbols-outlined text-sm leading-none">refresh</span>
              <span>Refresh image</span>
            </button>

            {/* Input */}
            <div className="mb-6">
              <input
                type="text"
                value={captchaInput}
                onChange={(e) => setCaptchaInput(e.target.value)}
                placeholder="Enter characters above..."
                className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-sm font-label text-on-surface placeholder-on-surface-variant/40 outline-none focus:border-primary/40 transition-colors tracking-[0.3em]"
              />
            </div>

            {/* Actions */}
            <div className="flex items-center space-x-3">
              <button
                onClick={() => setCaptchaVisible(false)}
                className="flex-1 py-3 rounded-xl border border-outline-variant/30 text-sm font-label text-on-surface-variant hover:bg-surface-container transition-colors"
              >
                CANCEL
              </button>
              <button className="flex-1 py-3 rounded-xl primary-gradient text-on-primary text-sm font-black tracking-widest hover:opacity-90 transition-opacity">
                VERIFY
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default SearchDownload
