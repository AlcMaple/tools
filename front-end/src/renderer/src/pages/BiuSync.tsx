import TopBar from "../components/TopBar";

function BiuSync(): JSX.Element {
  return (
    <div className="min-h-screen bg-background">
      <TopBar placeholder="Search archive logs..." />

      <main className="pt-16 px-8 py-10 custom-scrollbar overflow-y-auto">
        {/* Hero header */}
        <section className="mt-4 mb-10 flex items-start space-x-5">
          {/* Vertical gradient bar */}
          <div className="w-1 rounded-full self-stretch bg-gradient-to-b from-primary via-secondary to-transparent flex-shrink-0" />
          <div>
            <p className="font-label text-xs text-primary/70 tracking-[0.3em] uppercase mb-2">
              Biu Project Sync
            </p>
            <h1 className="text-6xl font-black tracking-tighter leading-none text-on-surface mb-3">
              Biu <span className="text-primary">Sync</span>
            </h1>
            <p className="text-on-surface-variant/50 text-sm font-label max-w-lg">
              Bidirectional sync between local Documents and the E: drive. Keep
              your Biu project safe and up-to-date across environments.
            </p>
          </div>
        </section>

        {/* Main grid */}
        <div className="grid grid-cols-12 gap-6">
          {/* Left col: actions + status */}
          <div className="col-span-7 space-y-5">
            {/* Action buttons */}
            <div className="grid grid-cols-2 gap-4">
              {/* Push to E Drive */}
              <button className="bg-surface-container rounded-xl p-6 border border-outline-variant/20 hover:border-b-4 hover:border-b-primary text-left transition-all duration-150 group">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                  <span className="material-symbols-outlined text-primary text-2xl leading-none">
                    upload_file
                  </span>
                </div>
                <h3 className="font-bold text-on-surface text-sm mb-1">
                  Push to E Drive
                </h3>
                <p className="text-xs font-label text-on-surface-variant/50">
                  Sync local changes → remote storage
                </p>
              </button>

              {/* Pull from E Drive */}
              <button className="bg-surface-container rounded-xl p-6 border border-outline-variant/20 hover:border-b-4 hover:border-b-secondary text-left transition-all duration-150 group">
                <div className="w-12 h-12 rounded-xl bg-secondary/10 flex items-center justify-center mb-4">
                  <span className="material-symbols-outlined text-secondary text-2xl leading-none">
                    download_for_offline
                  </span>
                </div>
                <h3 className="font-bold text-on-surface text-sm mb-1">
                  Pull from E Drive
                </h3>
                <p className="text-xs font-label text-on-surface-variant/50">
                  Fetch remote changes → local storage
                </p>
              </button>
            </div>

            {/* Sync Status panel */}
            <div className="bg-surface-container rounded-xl p-6 border border-outline-variant/20">
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center space-x-3">
                  <div className="w-2 h-2 rounded-full bg-tertiary/60" />
                  <div>
                    <h3 className="text-sm font-bold text-on-surface">
                      Idle & Standby
                    </h3>
                    <p className="text-[10px] font-label text-on-surface-variant/40 mt-0.5">
                      Last checked: 5 minutes ago
                    </p>
                  </div>
                </div>
                <button className="flex items-center space-x-1.5 text-xs font-label text-on-surface-variant/50 hover:text-primary transition-colors">
                  <span className="material-symbols-outlined text-sm leading-none">
                    refresh
                  </span>
                  <span>Check now</span>
                </button>
              </div>

              {/* Progress bar (dim) */}
              <div className="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full opacity-20"
                  style={{
                    background:
                      "linear-gradient(90deg, #ffb3b8 0%, #aac7ff 100%)",
                    width: "0%",
                  }}
                />
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] font-label text-on-surface-variant/30">
                  No active operation
                </span>
                <span className="text-[10px] font-label text-on-surface-variant/30">
                  --
                </span>
              </div>

              {/* Log area */}
              <div className="mt-5 bg-surface-container-lowest rounded-lg p-4 font-label text-[11px] space-y-1.5">
                <p className="text-on-surface-variant/40">
                  <span className="text-primary/40">09:41:02</span> — System
                  idle. Awaiting command.
                </p>
                <p className="text-on-surface-variant/30">
                  <span className="text-primary/30">09:30:17</span> — Last sync
                  completed successfully.
                </p>
                <p className="text-on-surface-variant/20">
                  <span className="text-primary/20">08:00:00</span> — Session
                  started.
                </p>
              </div>
            </div>
          </div>

          {/* Right col: session history + path mapping */}
          <div className="col-span-5 space-y-5">
            {/* Session History */}
            <div className="bg-surface-container rounded-xl p-6 border border-outline-variant/20">
              <h3 className="text-[10px] font-label text-on-surface-variant/40 tracking-widest uppercase mb-4">
                Session History
              </h3>
              <div className="space-y-4">
                {[
                  {
                    label: "Last Successful Sync",
                    value: "Today, 09:30 AM",
                    icon: "check_circle",
                    iconColor: "text-primary",
                  },
                  {
                    label: "Total Data Moved",
                    value: "2.4 GB this month",
                    icon: "database",
                    iconColor: "text-secondary",
                  },
                  {
                    label: "Files Impacted",
                    value: "1,204 files",
                    icon: "folder",
                    iconColor: "text-tertiary",
                  },
                ].map((item) => (
                  <div key={item.label} className="flex items-center space-x-3">
                    <div className="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center flex-shrink-0">
                      <span
                        className={`material-symbols-outlined ${item.iconColor} text-base leading-none`}
                      >
                        {item.icon}
                      </span>
                    </div>
                    <div>
                      <p className="text-[9px] font-label text-on-surface-variant/40 uppercase tracking-widest">
                        {item.label}
                      </p>
                      <p className="text-sm font-bold text-on-surface">
                        {item.value}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Path Mapping */}
            <div className="bg-surface-container rounded-xl p-6 border border-outline-variant/20">
              <h3 className="text-[10px] font-label text-on-surface-variant/40 tracking-widest uppercase mb-4">
                Path Mapping
              </h3>
              <div className="space-y-3">
                <div>
                  <p className="text-[9px] font-label text-on-surface-variant/40 uppercase tracking-widest mb-1.5">
                    Local Path
                  </p>
                  <code className="block bg-surface-container-lowest rounded-lg px-3 py-2 text-xs font-label text-secondary/80 break-all">
                    ~/Documents/Biu
                  </code>
                </div>
                <div className="flex items-center justify-center">
                  <span className="material-symbols-outlined text-on-surface-variant/20 text-xl leading-none">
                    swap_vert
                  </span>
                </div>
                <div>
                  <p className="text-[9px] font-label text-on-surface-variant/40 uppercase tracking-widest mb-1.5">
                    Remote Path
                  </p>
                  <code className="block bg-surface-container-lowest rounded-lg px-3 py-2 text-xs font-label text-primary/80 break-all">
                    E:\Biu
                  </code>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 flex items-center justify-between py-4 border-t border-outline-variant/10">
          <div className="flex items-center space-x-2 text-on-surface-variant/30">
            <span className="material-symbols-outlined text-base leading-none">
              shield_with_heart
            </span>
            <span className="text-xs font-label">
              All operations are encrypted end-to-end via local filesystem copy
            </span>
          </div>
          <span className="text-[10px] font-label text-on-surface-variant/20 tracking-widest">
            MAPLE TOOLS SYNC v1.0.0
          </span>
        </div>
      </main>
    </div>
  );
}

export default BiuSync;
