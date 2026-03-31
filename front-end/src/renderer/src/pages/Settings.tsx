import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSystemStats } from "../hooks/useSystemStats";
import { navGuard } from "../utils/navGuard";

// ── constants ────────────────────────────────────────────────
const NODE_ID_KEY = "xifan_node_id";
const SETTINGS_KEY = "xifan_settings";

interface HistoryEntry {
  text: string;
  time: number;
}

interface SavedSettings {
  downloadPath?: string;
  searchCacheEnabled?: boolean;
}

const DEFAULTS: Required<SavedSettings> = {
  downloadPath: "",
  searchCacheEnabled: true,
};

// ── helpers ──────────────────────────────────────────────────
function getOrCreateNodeId(): string {
  let id = localStorage.getItem(NODE_ID_KEY);
  if (!id) {
    const num = Math.floor(Math.random() * 9000 + 1000);
    const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    id = `ARC-${num}-${letter}`;
    localStorage.setItem(NODE_ID_KEY, id);
  }
  return id;
}

function readSavedSettings(): Required<SavedSettings> {
  try {
    const s = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) || "{}",
    ) as SavedSettings;
    return {
      downloadPath: s.downloadPath ?? DEFAULTS.downloadPath,
      searchCacheEnabled: s.searchCacheEnabled ?? DEFAULTS.searchCacheEnabled,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function formatHistoryTime(ts: number): string {
  const d = new Date(ts);
  return d
    .toLocaleString("en", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .toUpperCase();
}

function formatLastSave(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return d
    .toLocaleString("en", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .toUpperCase();
}

const PLATFORM = (() => {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Macintosh") || ua.includes("Mac OS")) return "macOS";
  if (ua.includes("Linux")) return "Linux";
  return "Desktop";
})();

const NODE_ID = getOrCreateNodeId();

// ── component ────────────────────────────────────────────────
function Settings(): JSX.Element {
  const navigate = useNavigate();

  // Biu sync paths (UI-only, not yet wired to backend)
  const [localPath, setLocalPath] = useState(
    "C:/Users/MapleTools/Documents/BiuProjects/Anime",
  );
  const [remotePath, setRemotePath] = useState(
    "ssh://obsidian-node-01/mnt/media/mapletools/biu-mirror",
  );

  // Staged settings — edit freely, only committed on Save
  const [staged, setStaged] =
    useState<Required<SavedSettings>>(readSavedSettings);

  // History — loaded from file on mount
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    window.systemApi
      .loadSettingsHistory()
      .then(setHistoryEntries)
      .catch(() => {});
  }, []);

  const lastSaved = historyEntries[0]?.time ?? null;

  // Whether staged differs from what's currently saved
  const saved = readSavedSettings();
  const isDirty =
    staged.downloadPath !== saved.downloadPath ||
    staged.searchCacheEnabled !== saved.searchCacheEnabled;

  // pendingNav: path to navigate to after dialog action ('__back__' for back button)
  const [pendingNav, setPendingNav] = useState<string | null>(null);

  const [isDark, setIsDark] = useState(() => {
    const stored = localStorage.getItem("theme");
    if (stored) return stored === "dark";
    return document.documentElement.classList.contains("dark");
  });

  const toggleTheme = () => {
    if (isDark) {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
      setIsDark(false);
    } else {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
      setIsDark(true);
    }
  };

  // Register/unregister nav guard whenever isDirty changes
  useEffect(() => {
    if (isDirty) {
      navGuard.setListener((to) => setPendingNav(to));
    } else {
      navGuard.setListener(null);
    }
    return () => navGuard.setListener(null);
  }, [isDirty]);

  const handleProceedNav = (save: boolean): void => {
    if (save) handleSave();
    navGuard.setListener(null);
    if (pendingNav === "__back__") navigate(-1);
    else if (pendingNav) navigate(pendingNav);
    setPendingNav(null);
  };

  // Save button feedback
  const [saveLabel, setSaveLabel] = useState<"save" | "saved">("save");

  const {
    diskFreeLabel,
    diskFreeRaw,
    diskTotal,
    activeTasks,
    networkOnline,
    speedLabel,
  } = useSystemStats();

  const storageStatus = (() => {
    if (diskFreeRaw === null || diskTotal === null || diskTotal === 0)
      return { label: "Unknown", color: "text-on-surface-variant/40" };
    const pct = diskFreeRaw / diskTotal;
    if (pct > 0.3) return { label: "Optimal", color: "text-secondary" };
    if (pct > 0.1) return { label: "Warning", color: "text-yellow-400" };
    return { label: "Critical", color: "text-red-400" };
  })();

  // ── history helper ──────────────────────────────────────────
  const recordChange = (text: string): void => {
    const updated = [{ text, time: Date.now() }, ...historyEntries].slice(
      0,
      20,
    );
    setHistoryEntries(updated);
    window.systemApi.saveSettingsHistory(updated).catch(() => {});
  };

  // ── save / reset ────────────────────────────────────────────
  const handleSave = (): void => {
    const current = readSavedSettings();
    const changes: string[] = [];
    if (staged.downloadPath !== current.downloadPath) {
      changes.push(
        staged.downloadPath
          ? `Download path → ${staged.downloadPath}`
          : "Download path cleared",
      );
    }
    if (staged.searchCacheEnabled !== current.searchCacheEnabled) {
      changes.push(
        `Search cache ${staged.searchCacheEnabled ? "enabled" : "disabled"}`,
      );
    }

    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          downloadPath: staged.downloadPath || undefined,
          searchCacheEnabled: staged.searchCacheEnabled,
        }),
      );
    } catch {
      /* ignore */
    }

    const label =
      changes.length > 0 ? changes.join("; ") : "Configuration saved";
    recordChange(label);
    setSaveLabel("saved");
    setTimeout(() => setSaveLabel("save"), 2000);
  };

  const handleReset = (): void => {
    setStaged({ ...DEFAULTS });
    setLocalPath("C:/Users/MapleTools/Documents/BiuProjects/Anime");
    setRemotePath("ssh://obsidian-node-01/mnt/media/mapletools/biu-mirror");
  };

  // ── folder picker ───────────────────────────────────────────
  const handlePickDownloadFolder = async (): Promise<void> => {
    const picked = await window.systemApi.pickFolder();
    if (!picked) return;
    setStaged((s) => ({ ...s, downloadPath: picked }));
  };

  const handleClearDownloadPath = (): void => {
    setStaged((s) => ({ ...s, downloadPath: "" }));
  };

  return (
    <div className="min-h-full bg-surface">
      {/* Header */}
      <header className="fixed top-0 right-0 left-64 h-16 z-40 bg-background/80 backdrop-blur-xl border-b border-white/5 flex items-center justify-between px-8">
        <div className="flex items-center gap-4">
          <button
            onClick={() => (isDirty ? setPendingNav("__back__") : navigate(-1))}
            className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-variant/40 rounded-full transition-colors"
          >
            <span className="material-symbols-outlined text-xl leading-none">
              arrow_back
            </span>
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
            <span className="material-symbols-outlined text-sm leading-none">
              storage
            </span>
            <span className="font-label text-[10px] tracking-widest">
              {diskFreeLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 text-on-surface-variant/60">
            <span className={`material-symbols-outlined text-sm leading-none ${activeTasks > 0 ? "text-primary flex-shrink-0 animate-pulse" : ""}`}>
              downloading
            </span>
            <span className={`font-label text-[10px] tracking-widest ${activeTasks > 0 ? "text-primary" : ""}`}>
              {activeTasks} TASKS
            </span>
          </div>
          <div className="flex items-center gap-2 text-on-surface-variant/60">
            <span className="material-symbols-outlined text-sm leading-none">
              speed
            </span>
            <span className="font-label text-[10px] tracking-widest">
              {speedLabel}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${networkOnline ? "bg-green-400 animate-pulse" : "bg-red-500"}`}
            />
            <span
              className={`material-symbols-outlined text-sm leading-none ${networkOnline ? "text-green-400" : "text-red-500"}`}
            >
              {networkOnline ? "wifi_tethering" : "wifi_off"}
            </span>
            <span
              className={`font-label text-[10px] tracking-widest ${networkOnline ? "text-green-400" : "text-red-500"}`}
            >
              {networkOnline ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
          <span className="h-4 w-px bg-white/10" />
          <button
            onClick={toggleTheme}
            className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-variant/40 rounded-full transition-colors flex items-center justify-center"
          >
            <span className="material-symbols-outlined text-sm leading-none">
              {isDark ? "light_mode" : "dark_mode"}
            </span>
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="pt-32 pb-20 px-12 max-w-7xl mx-auto">
        <section className="mb-16">
          <h1 className="font-headline font-black text-6xl tracking-tighter text-on-surface mb-2">
            SETTINGS<span className="text-primary">.</span>
          </h1>
          <p className="font-label text-sm uppercase tracking-[0.3em] text-on-surface-variant/40 max-w-xl">
            Configure the core operational parameters for MapleTools
            environment. Changes take effect after saving.
          </p>
        </section>

        <div className="grid grid-cols-12 gap-10 items-start">
          {/* Left Column */}
          <section className="col-span-12 lg:col-span-7 space-y-8">
            {/* Biu Sync Configuration */}
            <div className="bg-surface-container p-8 rounded-xl border border-white/5">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary">
                    folder_shared
                  </span>
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
                      <span className="material-symbols-outlined text-sm leading-none">
                        folder_open
                      </span>
                    </button>
                  </div>
                </div>
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
                      <span className="material-symbols-outlined text-sm leading-none">
                        link
                      </span>
                    </button>
                  </div>
                </div>
                <p className="font-body text-xs text-on-surface-variant/40 leading-relaxed border-t border-white/5 pt-4">
                  These paths define the architectural bridge between your local
                  workstation and the remote Biu project server. Automated hash
                  verification will be performed during each synchronization
                  cycle.
                </p>
              </div>
            </div>

            {/* Download Save Path */}
            <div className="bg-surface-container p-8 rounded-xl border border-white/5">
              <div className="flex items-center gap-3 mb-8">
                <span className="material-symbols-outlined text-primary">
                  save_alt
                </span>
                <h2 className="font-headline font-bold text-xl uppercase tracking-tight">
                  Download Save Path
                </h2>
              </div>
              <div className="space-y-2">
                <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant/60">
                  Save Location
                </label>
                <div className="flex gap-2">
                  <div className="flex-1 bg-surface-container-highest rounded-md px-4 py-3 flex items-center gap-3">
                    <span className="material-symbols-outlined text-on-surface-variant/40 text-sm leading-none">
                      folder_open
                    </span>
                    <span
                      className={`flex-1 text-sm font-label truncate ${staged.downloadPath ? "text-on-surface" : "text-on-surface-variant/30"}`}
                    >
                      {staged.downloadPath || "Default: script directory"}
                    </span>
                    {staged.downloadPath && (
                      <button
                        onClick={handleClearDownloadPath}
                        className="text-on-surface-variant/40 hover:text-on-surface transition-colors flex-shrink-0"
                      >
                        <span className="material-symbols-outlined text-sm leading-none">
                          close
                        </span>
                      </button>
                    )}
                  </div>
                  <button
                    onClick={handlePickDownloadFolder}
                    className="bg-surface-container-high hover:bg-surface-bright px-4 rounded-md transition-colors flex items-center justify-center"
                  >
                    <span className="material-symbols-outlined text-sm leading-none">
                      drive_folder_upload
                    </span>
                  </button>
                </div>
                <p className="font-body text-xs text-on-surface-variant/40 leading-relaxed border-t border-white/5 pt-4">
                  Downloaded files are saved to{" "}
                  <span className="text-on-surface-variant/60">
                    &lt;path&gt;/&lt;title&gt;/
                  </span>
                  . Leave empty to use the default directory alongside the
                  scripts.
                </p>
              </div>
            </div>

            {/* Search Preferences */}
            <div className="bg-surface-container p-8 rounded-xl border border-white/5">
              <div className="flex items-center gap-3 mb-8">
                <span className="material-symbols-outlined text-primary">
                  search_insights
                </span>
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
                    When enabled, previously searched titles will load instantly
                    from local storage. Disable to force fresh metadata scraping
                    from original indexers.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer mt-1 flex-shrink-0">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={staged.searchCacheEnabled}
                    onChange={(e) =>
                      setStaged((s) => ({
                        ...s,
                        searchCacheEnabled: e.target.checked,
                      }))
                    }
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
                    Platform
                  </span>
                  <span className="font-label text-xs text-on-surface uppercase">
                    {PLATFORM}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-label text-xs text-on-surface-variant/50 uppercase tracking-widest">
                    Node ID
                  </span>
                  <span className="font-label text-xs text-on-surface uppercase">
                    {NODE_ID}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-label text-xs text-on-surface-variant/50 uppercase tracking-widest">
                    Last Saved
                  </span>
                  <span className="font-label text-xs text-on-surface uppercase">
                    {formatLastSave(lastSaved)}
                  </span>
                </div>
                <div className="w-full h-px bg-white/5 my-2" />
                <div className="flex justify-between items-center">
                  <span className="font-label text-xs text-on-surface-variant/50 uppercase tracking-widest">
                    Storage
                  </span>
                  <span
                    className={`font-label text-xs uppercase ${storageStatus.color}`}
                  >
                    {storageStatus.label}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-label text-xs text-on-surface-variant/50 uppercase tracking-widest">
                    Network
                  </span>
                  <span
                    className={`font-label text-xs uppercase flex items-center gap-1.5 ${networkOnline ? "text-secondary" : "text-red-400"}`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${networkOnline ? "bg-secondary animate-pulse" : "bg-red-400"}`}
                    />
                    {networkOnline ? "Connected" : "Offline"}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-label text-xs text-on-surface-variant/50 uppercase tracking-widest">
                    Active Tasks
                  </span>
                  <span
                    className={`font-label text-xs uppercase ${activeTasks > 0 ? "text-primary" : "text-on-surface-variant/40"}`}
                  >
                    {activeTasks}
                  </span>
                </div>
                {/* Unsaved changes indicator — always rendered to avoid layout shift */}
                <div className="flex items-center gap-2 pt-2 border-t border-white/5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors ${isDirty ? "bg-yellow-400 animate-pulse" : "bg-transparent"}`}
                  />
                  <span
                    className={`font-label text-[10px] uppercase tracking-widest transition-opacity duration-200 ${isDirty ? "text-yellow-400 opacity-100" : "opacity-0 select-none"}`}
                  >
                    Unsaved changes
                  </span>
                </div>
              </div>
              <div className="space-y-3">
                <button
                  onClick={handleSave}
                  className="w-full py-4 bg-gradient-to-r from-primary to-primary-container rounded-full text-on-primary-container font-headline font-black text-sm uppercase tracking-[0.2em] shadow-[0_10px_30px_rgba(240,145,153,0.2)] hover:scale-[1.02] active:scale-100 transition-all flex items-center justify-center gap-2"
                >
                  {saveLabel === "saved" && (
                    <span className="material-symbols-outlined text-sm leading-none">
                      check
                    </span>
                  )}
                  {saveLabel === "save" ? "Save Changes" : "Saved"}
                </button>
                <button
                  onClick={handleReset}
                  className="w-full py-4 text-primary font-headline font-bold text-sm uppercase tracking-[0.2em] hover:bg-surface-variant/40 rounded-full transition-all"
                >
                  Reset to Default
                </button>
              </div>
            </div>

            {/* Change History */}
            <div className="p-8 bg-surface-container rounded-xl border border-white/5">
              <div className="flex items-center gap-3 mb-6">
                <span className="material-symbols-outlined text-secondary">
                  history
                </span>
                <h2 className="font-headline font-bold text-sm uppercase tracking-widest">
                  Change History
                </h2>
              </div>
              <ul className="space-y-4">
                {historyEntries.length === 0 ? (
                  <li className="font-label text-xs text-on-surface-variant/30 uppercase tracking-widest">
                    No changes recorded yet
                  </li>
                ) : (
                  historyEntries.slice(0, 5).map((entry, i) => (
                    <li key={i} className="flex items-start gap-4 group">
                      <div className="mt-1 w-1.5 h-1.5 rounded-full bg-primary/40 group-hover:bg-primary transition-colors flex-shrink-0" />
                      <div className="space-y-1">
                        <p className="font-label text-[11px] text-on-surface/80 uppercase leading-tight">
                          {entry.text}
                        </p>
                        <p className="font-label text-[9px] text-on-surface-variant/40 uppercase tracking-tighter">
                          {formatHistoryTime(entry.time)}
                        </p>
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </aside>
        </div>
      </div>

      {/* Background watermark */}
      {/* <div className="fixed bottom-0 right-0 p-8 pointer-events-none select-none">
        <p className="font-label text-[150px] font-black text-white/[0.02] leading-none tracking-tighter uppercase">
          Config
        </p>
      </div> */}

      {/* Unsaved changes navigation warning dialog */}
      {pendingNav !== null && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/40"
          onClick={() => setPendingNav(null)}
        >
          <div
            className="w-full max-w-md bg-white/10 backdrop-blur-[40px] rounded-xl p-10 flex flex-col items-center text-center shadow-[0_40px_80px_rgba(0,0,0,0.5)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative mb-8">
              <div className="absolute inset-0 bg-primary/20 blur-2xl rounded-full" />
              <span
                className="material-symbols-outlined text-primary text-6xl relative"
                style={{ fontVariationSettings: '"wght" 200' }}
              >
                warning_amber
              </span>
            </div>
            <h2 className="text-2xl font-black font-headline tracking-tight text-white mb-3">
              Unsaved Changes Detected
            </h2>
            <p className="text-white/70 font-body text-sm mb-10 leading-relaxed px-4">
              You have unsaved configuration changes. Leaving now will
              permanently discard them.
            </p>
            <div className="flex flex-col w-full gap-3">
              <button
                onClick={() => handleProceedNav(true)}
                className="w-full py-4 rounded-full bg-gradient-to-r from-primary to-primary-container text-on-primary-container font-headline font-extrabold text-sm tracking-widest uppercase hover:scale-[1.02] active:scale-100 transition-transform"
              >
                Save &amp; Leave
              </button>
              <button
                onClick={() => handleProceedNav(false)}
                className="w-full py-4 rounded-full bg-white/5 hover:bg-white/10 text-white font-label font-bold text-xs tracking-[0.2em] uppercase transition-colors"
              >
                Discard &amp; Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Settings;
