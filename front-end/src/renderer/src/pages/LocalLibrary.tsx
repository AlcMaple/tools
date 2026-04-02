import { useState, useMemo } from 'react'
import TopBar from '../components/TopBar'

export default function LocalLibrary(): JSX.Element {
  const [isScanModalOpen, setIsScanModalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Dummy data for posters based on the HTML mockup
  const posters = [
    {
      id: 1,
      title: "Neon Genesis Evangelion",
      nativeTitle: "新世紀エヴァンゲリオン",
      tags: "Sci-Fi • Psychological",
      episodes: 26,
      specs: "1080p • MKV • 24.2 GB",
      image: "https://lh3.googleusercontent.com/aida-public/AB6AXuAAex9u9ekIpmrZFERhLoFACYNgVbdHfpS9TbMmcspi9tT7G3b-JQZE14ar6d8rKxVUqSGaX6nxuhX7vwd5P3K7E0myfXyomsZ6EQh4QPk8R_pQojJ-o-nMzk5wJXHpSXvE-alUxx1adwOkneZcYOKDIBU1R63-H1xSWKWGH-k2ZL8Gz16Hkw3uicOerQEzEK1oVK-qYsSj2w7SoH8C7lGKHjD1wHxHwlGtAnx-1lFaqf0uUhim8Uv7S6NRoeHGIjtiyG4p9rmmBQ"
    },
    {
      id: 2,
      title: "Clannad: After Story",
      nativeTitle: "クラナド アフターストーリー",
      tags: "Drama • Romance",
      episodes: 24,
      specs: "4K • Remastered • 48.5 GB",
      image: "https://lh3.googleusercontent.com/aida-public/AB6AXuAcPcSQwYkMDnYC0vO1ySBUI_a0zwFpI15jvVnepRQJ0ILVaeokLZJThUV0rYlauv_kq_akiWN13746Yjq7Rp0NyMjf0xU89qIc0i8dYSZdaYCG3TlXqMrhigoWfP4LVXC4IRlNdibJGquh6G9A4jyib7Kt-VQ9ATIs2MXB8jhZKokxzih-OpPK5m_V-mrx5zrgbOjjhEMidJXuX3y0nVgg6DDHfprt2TfuAkjWvkuHuN6dAdbDSo9I7Zo7VKakSmKB9bu-KbGGrw"
    },
    {
      id: 3,
      title: "Cowboy Bebop",
      nativeTitle: "カウボーイビバップ",
      tags: "Space Western • Noir",
      episodes: 26,
      specs: "1080p • BLURAY • 18.9 GB",
      image: "https://lh3.googleusercontent.com/aida-public/AB6AXuABaUtPmlJc5ma7PyolRn_gYPjp5ss_Hv-7I4X0zkrSzIsy5c7EaDjUawHugOIn8y2DUiFk_QzVxIfICrCS_HUaQoJzZS8uptUrgH7DVpRXGl_dY3RUsG0eSwWIynSbyVJL1OKQMuixjB0fgdG_oN67giG-4VbvTF6g_LQlUwr4_Dr81-1JObWd6nLOnQYAI4lCBgkKzQdIcc9GHNAYbIBWwtINamZixCJZqnhcKc8KqLuFyf5xkuJEgeNEKDkwaxVyRbcyKlgM_A"
    },
    {
      id: 4,
      title: "Mushishi",
      nativeTitle: "蟲師",
      tags: "Slice of Life • Supernatural",
      episodes: 26,
      specs: "1080p • WEB-DL • 12.1 GB",
      image: "https://lh3.googleusercontent.com/aida-public/AB6AXuAtBSGzYMY1Rf_luL7yYcjeFlrCbdAA2_rdrNdCO6Am5FmsSWPTOoBr3hKjzvuiNqNIsI3hVysUvqEhTiF_ANMGCzvzhTaIgFT0PUurzKlFwQq_WO48d4s0VBgJ-StAlzL0LJWWb93tr1Syl_i5my_ki2uRAmanxEhKLeDZAr66oB9R8rplcHBy5_NDqcsdRgh3XRZwSNvMcIzJTuLxsQTuVzkKGUc1fYBaewa-bZaWpQK29O03K8K_5U4qdVUa5KOL0LekOEO3bw"
    },
    {
      id: 5,
      title: "Mononoke",
      nativeTitle: "モノノ怪",
      tags: "Mystery • Horror",
      episodes: 12,
      specs: "1080p • BD-RIP • 9.8 GB",
      image: "https://lh3.googleusercontent.com/aida-public/AB6AXuDFLxxZM8TU9XgCK1TlW0cBbWuJt0PnE5pOjJWDHhYqWweuEi_FteoHiRoRsJD7NmAeSX1__1wPSrv6xMPOODfuAVMv-y8JuFl5WriwOCCJ_HYgdVL7Q0nja3MuXBM9ralF4KGzHm7zRxJLPlAyvlI-ElGxfsWICob_pwqk3q9GGETVZDT8ntEfNYJ-RxJIaaZX7dRbPuv2S8qYi_rllgjo6xGVtqUZwDcxFaSiEUjP5tFZ250uGz9-IwcgQ1mtdBZPkii8wLQwkA"
    }
  ]

  const filteredPosters = useMemo(() => {
    if (!searchQuery.trim()) return posters;
    const query = searchQuery.toLowerCase();
    return posters.filter(p => 
      p.title.toLowerCase().includes(query) || 
      p.nativeTitle.toLowerCase().includes(query)
    );
  }, [searchQuery]);

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="Search in library..." onSearch={setSearchQuery} />
      <div className="pt-24 pb-8">
      {/* Hero Actions & Stats Area */}
      <section className="px-12 pb-6">
        <div className="flex justify-between items-start mb-12">
          <div>
            <h2 className="font-headline font-black text-5xl tracking-tighter text-on-surface mb-2">Local Library</h2>
            <div className="flex items-center gap-4 text-on-surface-variant font-label text-sm">
              <span className="flex items-center gap-1.5"><span className="text-primary font-bold">482</span> Titles</span>
              <span className="w-1 h-1 bg-outline-variant rounded-full"></span>
              <span className="flex items-center gap-1.5"><span className="text-primary font-bold">12.4</span> TB Indexed</span>
              <span className="w-1 h-1 bg-outline-variant rounded-full"></span>
              <span className="flex items-center gap-1.5">Last update: 2m ago</span>
            </div>
          </div>
          <button 
            className="bg-primary text-on-primary font-label font-bold text-sm px-8 py-4 rounded-full flex items-center gap-3 shadow-lg shadow-primary/20 hover:brightness-110 transition-all active:scale-95 group"
            onClick={() => setIsScanModalOpen(true)}
          >
            <span className="material-symbols-outlined leading-none">folder_zip</span>
            SCAN LOCAL FOLDERS
          </button>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-col gap-6 mb-8">
          <div className="flex items-center gap-3">
            <span className="font-label text-xs text-on-surface-variant uppercase tracking-widest mr-2">Sort by</span>
            <button className="px-5 py-2 rounded-full bg-primary text-on-primary font-label text-xs font-bold uppercase tracking-widest">All Titles</button>
            <button className="px-5 py-2 rounded-full bg-surface-container-high text-on-surface-variant font-label text-xs font-bold uppercase tracking-widest hover:text-on-surface transition-colors">Recently Added</button>
            <button className="px-5 py-2 rounded-full bg-surface-container-high text-on-surface-variant font-label text-xs font-bold uppercase tracking-widest hover:text-on-surface transition-colors">By Resolution</button>
            <button className="px-5 py-2 rounded-full bg-surface-container-high text-on-surface-variant font-label text-xs font-bold uppercase tracking-widest hover:text-on-surface transition-colors">A-Z</button>
          </div>
        </div>
      </section>

      {/* Poster Wall Grid */}
      <section className="px-12 pb-32 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-8 gap-y-12">
        {filteredPosters.map((poster) => (
          <div key={poster.id} className="group relative cursor-pointer">
            <div className="aspect-[2/3] w-full rounded-lg overflow-hidden bg-surface-container-lowest relative ring-1 ring-outline-variant/30 transition-transform duration-500">
              <img 
                className="w-full h-full object-cover grayscale-[20%] group-hover:grayscale-0 transition-all duration-500" 
                alt={poster.title} 
                src={poster.image}
              />
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-surface-variant/70 backdrop-blur-md p-6 flex flex-col justify-start pt-8">
                <div className="mb-4">
                  <h4 className="font-headline font-bold text-lg text-on-surface mb-1 leading-tight line-clamp-2">{poster.title}</h4>
                  <p className="font-body text-primary text-[10px] font-bold uppercase tracking-widest mb-2">{poster.tags}</p>
                  <p className="font-body text-primary text-sm font-bold italic opacity-80">{poster.nativeTitle}</p>
                </div>
                <div className="flex items-center justify-between border-t border-outline-variant/30 pt-4 mt-auto">
                  <span className="font-label text-xs text-primary/80">{poster.episodes} Episodes</span>
                  <span className="material-symbols-outlined text-primary leading-none">play_circle</span>
                </div>
              </div>
            </div>
            <h3 className="mt-4 font-headline font-bold text-on-surface truncate group-hover:text-primary transition-colors">{poster.title}</h3>
            <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">{poster.specs}</p>
          </div>
        ))}
      </section>

      {/* Floating Status Bar */}
      <div className="fixed bottom-8 right-8 bg-surface-container-lowest/80 backdrop-blur-md ring-1 ring-outline-variant/30 rounded-full px-6 py-3 flex items-center justify-between shadow-2xl z-[55]">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
            <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">Auto-Scan Active</span>
          </div>
          <div className="h-4 w-[1px] bg-outline-variant/30"></div>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-sm leading-none">hard_drive</span>
            <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">NAS-01: CONNECTED</span>
          </div>
        </div>
        <div className="flex items-center gap-4 ml-8">
          <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest italic">Archiving current sector...</span>
          <div className="w-32 h-1 bg-surface-container-highest rounded-full overflow-hidden">
            <div className="h-full bg-secondary" style={{ width: '45%' }}></div>
          </div>
        </div>
      </div>

      {/* Scan Folders Modal */}
      {isScanModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-surface-container-lowest/80 backdrop-blur-sm">
          <div 
            className="absolute inset-0" 
            onClick={() => setIsScanModalOpen(false)}
          ></div>
          
          <div className="relative bg-surface border border-outline-variant/30 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl">
            <div className="p-8 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low">
              <div>
                <h3 className="font-headline font-black text-2xl tracking-tighter text-on-surface">Path Manager</h3>
                <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mt-1">Configure library source folders</p>
              </div>
              <button 
                className="text-on-surface-variant hover:text-on-surface transition-colors leading-none"
                onClick={() => setIsScanModalOpen(false)}
              >
                <span className="material-symbols-outlined leading-none">close</span>
              </button>
            </div>
            
            <div className="p-8 space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between p-4 rounded-xl bg-surface-container-high border border-outline-variant/30 group">
                  <div className="flex items-center gap-4">
                    <span className="material-symbols-outlined text-on-surface-variant leading-none">folder</span>
                    <div>
                      <p className="text-xs font-label text-on-surface font-bold">D:\Anime</p>
                      <p className="text-[10px] text-on-surface-variant font-label uppercase">Main Archive</p>
                    </div>
                  </div>
                  <button className="text-on-surface-variant hover:text-error opacity-0 group-hover:opacity-100 transition-all leading-none">
                    <span className="material-symbols-outlined text-sm leading-none">delete</span>
                  </button>
                </div>
                
                <div className="flex items-center justify-between p-4 rounded-xl bg-surface-container-high border border-outline-variant/30 group">
                  <div className="flex items-center gap-4">
                    <span className="material-symbols-outlined text-on-surface-variant leading-none">folder</span>
                    <div>
                      <p className="text-xs font-label text-on-surface font-bold">E:\Downloads\Seasonals</p>
                      <p className="text-[10px] text-on-surface-variant font-label uppercase">Staging Area</p>
                    </div>
                  </div>
                  <button className="text-on-surface-variant hover:text-error opacity-0 group-hover:opacity-100 transition-all leading-none">
                    <span className="material-symbols-outlined text-sm leading-none">delete</span>
                  </button>
                </div>
              </div>
              
              <button className="w-full py-4 border-2 border-dashed border-outline-variant/30 rounded-xl text-on-surface-variant hover:text-primary hover:border-primary/50 hover:bg-primary/5 transition-all flex items-center justify-center gap-3 font-label text-xs font-bold uppercase tracking-widest">
                <span className="material-symbols-outlined text-sm leading-none">add</span>
                Add New Path
              </button>
            </div>
            
            <div className="p-8 bg-surface-container-low border-t border-outline-variant/30 flex gap-4">
              <button 
                className="flex-1 py-4 bg-surface-container-highest text-on-surface font-label text-xs font-bold uppercase tracking-widest rounded-full hover:bg-surface-bright transition-colors"
                onClick={() => setIsScanModalOpen(false)}
              >
                Cancel
              </button>
              <button className="flex-[2] py-4 bg-primary text-on-primary font-label text-xs font-bold uppercase tracking-widest rounded-full shadow-lg shadow-primary/20 hover:brightness-110 transition-all active:scale-95">
                Start Scanning
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  )
}
