import TopBar from "../components/TopBar";

function AvatarPlaceholder({
  icon = "person",
  className = "",
}: {
  icon?: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`bg-surface-container-high rounded-full flex items-center justify-center ${className}`}
    >
      <span className="material-symbols-outlined text-on-surface-variant/30 text-base leading-none">
        {icon}
      </span>
    </div>
  );
}

function AnimeInfo(): JSX.Element {
  return (
    <div className="min-h-screen bg-background">
      <TopBar placeholder="Lookup titles from bgm.tv..." />

      <main className="pt-16 px-8 py-10 custom-scrollbar overflow-y-auto">
        {/* Main grid */}
        <div className="grid grid-cols-12 gap-8 mt-4">
          {/* Left: Poster */}
          <div className="col-span-4">
            <div className="sticky top-24">
              {/* Poster */}
              <div className="relative mb-5">
                <div className="aspect-[2/3] bg-surface-container-high rounded-xl overflow-hidden flex items-center justify-center">
                  <span className="material-symbols-outlined text-on-surface-variant/20 text-6xl">
                    image
                  </span>
                </div>
                {/* Floating rating card */}
                <div className="absolute bottom-4 right-4 glass-panel rounded-xl p-3 border border-outline-variant/20">
                  <p className="text-[9px] font-label text-on-surface-variant/60 tracking-widest uppercase mb-1">
                    Bangumi Rating
                  </p>
                  <p className="text-xl font-black text-primary leading-none">
                    8.2
                  </p>
                  <p className="text-[9px] font-label text-on-surface-variant/50">
                    / 10
                  </p>
                </div>
              </div>

              {/* Action buttons */}
              <button className="w-full primary-gradient text-on-primary text-sm font-black tracking-wider py-3.5 rounded-full mb-3 flex items-center justify-center space-x-2 hover:opacity-90 transition-opacity">
                <span className="material-symbols-outlined text-base leading-none">
                  add
                </span>
                <span>Add to Archive</span>
              </button>
              <button className="w-full bg-surface-container border border-outline-variant/30 text-on-surface-variant text-sm font-label py-3 rounded-full flex items-center justify-center space-x-2 hover:bg-surface-container-high transition-colors">
                <span className="material-symbols-outlined text-base leading-none">
                  open_in_new
                </span>
                <span>Official Site</span>
              </button>
            </div>
          </div>

          {/* Right: Info */}
          <div className="col-span-8">
            {/* Status badges */}
            <div className="flex items-center space-x-3 mb-5">
              <span className="px-3 py-1 rounded-full bg-primary/10 text-primary text-[10px] font-label font-bold tracking-wider border border-primary/20">
                Currently Airing
              </span>
              <span className="text-xs font-label text-on-surface-variant/40">
                TV Series · 24m per ep
              </span>
            </div>

            {/* Title */}
            <h1 className="text-7xl font-black tracking-tighter leading-[0.9] mb-6 text-on-surface">
              NEON ARCHIVE: <span className="text-primary">SIGNAL</span>
            </h1>

            {/* Stats row */}
            <div className="flex items-center space-x-6 mb-8 pb-8 border-b border-outline-variant/20">
              {[
                {
                  label: "Air Date",
                  value: "Oct 2024",
                  icon: "calendar_today",
                },
                { label: "Studio", value: "TRIGGER", icon: "movie" },
                { label: "Genre", value: "Sci-Fi · Action", icon: "label" },
              ].map((stat) => (
                <div key={stat.label} className="flex items-center space-x-2">
                  <span className="material-symbols-outlined text-primary/60 text-base leading-none">
                    {stat.icon}
                  </span>
                  <div>
                    <p className="text-[9px] font-label text-on-surface-variant/40 uppercase tracking-widest">
                      {stat.label}
                    </p>
                    <p className="text-sm font-bold text-on-surface">
                      {stat.value}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Summary */}
            <div className="bg-surface-container rounded-xl p-6 mb-8 border border-outline-variant/20">
              <h3 className="text-[10px] font-label text-on-surface-variant/40 tracking-widest uppercase mb-3">
                The Narrative
              </h3>
              <p className="text-sm font-body text-on-surface-variant/70 leading-relaxed">
                In a sprawling neon metropolis where memory can be bought and
                sold, a rogue archivist discovers fragments of a signal — one
                that holds the key to humanity's forgotten origin. Pursued by
                megacorps and underground syndicates alike, she must navigate a
                web of digital ghosts and fractured identities to decode a truth
                that was never meant to be found.
              </p>
            </div>

            {/* Staff bento grid */}
            <div className="mb-8">
              <h3 className="text-[10px] font-label text-on-surface-variant/40 tracking-widest uppercase mb-4">
                Staff
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {[
                  {
                    role: "Director",
                    name: "Hiroshi Tanaka",
                    icon: "videocam",
                  },
                  { role: "Composer", name: "Yuki Sato", icon: "music_note" },
                  {
                    role: "Character Design",
                    name: "Akira Mori",
                    icon: "draw",
                  },
                  { role: "Script", name: "Nanami Kato", icon: "edit_note" },
                ].map((staff) => (
                  <div
                    key={staff.role}
                    className="flex items-center space-x-3 bg-surface-container p-4 rounded-xl border border-outline-variant/20"
                  >
                    <AvatarPlaceholder
                      icon="person"
                      className="w-10 h-10 flex-shrink-0"
                    />
                    <div>
                      <p className="text-[9px] font-label text-on-surface-variant/40 uppercase tracking-widest">
                        {staff.role}
                      </p>
                      <p className="text-sm font-bold text-on-surface">
                        {staff.name}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom metadata strip */}
        <div className="mt-6 bg-surface-container-low rounded-xl px-6 py-4 border border-outline-variant/10 flex items-center justify-between">
          <div className="flex items-center space-x-8">
            {[
              { label: "Database ID", value: "BGM-498271" },
              { label: "File Density", value: "24 episodes · 4K HDR" },
              { label: "Metadata Sync", value: "Synced 2h ago" },
            ].map((meta) => (
              <div key={meta.label}>
                <p className="text-[9px] font-label text-on-surface-variant/30 uppercase tracking-widest">
                  {meta.label}
                </p>
                <p className="text-xs font-label text-on-surface-variant/60 mt-0.5">
                  {meta.value}
                </p>
              </div>
            ))}
          </div>
          <button className="flex items-center space-x-2 px-4 py-2 rounded-lg border border-outline-variant/30 text-xs font-label text-on-surface-variant hover:bg-surface-container transition-colors">
            <span className="material-symbols-outlined text-sm leading-none">
              ios_share
            </span>
            <span>Export Record</span>
          </button>
        </div>
      </main>
    </div>
  );
}

export default AnimeInfo;
