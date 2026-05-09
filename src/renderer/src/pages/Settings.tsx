import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useSystemStats } from "../hooks/useSystemStats";

// ── persistence keys ─────────────────────────────────────────
const NODE_ID_KEY = "xifan_node_id";
const SETTINGS_KEY = "xifan_settings";
const ACTIVE_CATEGORY_KEY = "maple-settings-category";
const TWEAKS_KEY = "maple-settings-tweaks";

interface SavedSettings {
  downloadPath?: string;
  searchCacheEnabled?: boolean;
  minimizeOnClose?: boolean;
}

const DEFAULTS: Required<SavedSettings> = {
  downloadPath: "",
  searchCacheEnabled: true,
  minimizeOnClose: false,
};

// Settings-page-specific UI tweaks — meta-controls in the floating Tweaks panel.
type NavStyle = "rail" | "tabs";
type Density = "compact" | "comfortable" | "spacious";

interface Tweaks {
  navStyle: NavStyle;
  density: Density;
}

const TWEAKS_DEFAULT: Tweaks = {
  navStyle: "rail",
  density: "comfortable",
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
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as SavedSettings;
    return {
      downloadPath: s.downloadPath ?? DEFAULTS.downloadPath,
      searchCacheEnabled: s.searchCacheEnabled ?? DEFAULTS.searchCacheEnabled,
      minimizeOnClose: s.minimizeOnClose ?? DEFAULTS.minimizeOnClose,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(s: Required<SavedSettings>): void {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        downloadPath: s.downloadPath || undefined,
        searchCacheEnabled: s.searchCacheEnabled,
        minimizeOnClose: s.minimizeOnClose,
      }),
    );
  } catch { /* ignore */ }
}

function readTweaks(): Tweaks {
  try {
    const raw = JSON.parse(localStorage.getItem(TWEAKS_KEY) || "{}") as Partial<Tweaks>;
    return {
      navStyle: raw.navStyle === "tabs" ? "tabs" : "rail",
      density: raw.density === "compact" || raw.density === "spacious" ? raw.density : "comfortable",
    };
  } catch { return { ...TWEAKS_DEFAULT }; }
}

const PLATFORM = (() => {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Macintosh") || ua.includes("Mac OS")) return "macOS";
  if (ua.includes("Linux")) return "Linux";
  return "Desktop";
})();

const NODE_ID = getOrCreateNodeId();

type CategoryId = "general" | "downloads" | "sync" | "appearance" | "about";

const CATEGORIES: ReadonlyArray<{
  id: CategoryId;
  label: string;
  en: string;
  icon: string;
  desc: string;
}> = [
  { id: "general", label: "通用", en: "General", icon: "tune", desc: "常用偏好与基础行为" },
  { id: "downloads", label: "下载", en: "Downloads", icon: "download", desc: "保存路径与下载默认行为" },
  { id: "sync", label: "云同步", en: "Sync", icon: "cloud_sync", desc: "坚果云 WebDAV 配置" },
  { id: "appearance", label: "外观", en: "Appearance", icon: "palette", desc: "主题切换" },
  { id: "about", label: "关于", en: "About", icon: "info", desc: "版本、节点与系统信息" },
];

// ── Row / Block primitives ───────────────────────────────────
function Row({
  icon,
  title,
  desc,
  density,
  control,
}: {
  icon: string;
  title: string;
  desc: string;
  density: Density;
  control: ReactNode;
}): JSX.Element {
  const heightCls =
    density === "compact" ? "py-3.5" : density === "spacious" ? "py-7" : "py-5";
  return (
    <div className={`group flex items-start gap-5 px-6 ${heightCls} hover:bg-on-surface/[0.02] transition-colors`}>
      <div className="mt-0.5 w-9 h-9 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant flex-shrink-0">
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 20 }}>{icon}</span>
      </div>
      <div className="flex-1 min-w-0 pr-4">
        <h3 className="font-headline font-semibold text-[14px] text-on-surface tracking-tight">{title}</h3>
        <p className="font-body text-[12px] leading-relaxed text-on-surface-variant/60 mt-1 max-w-2xl">{desc}</p>
      </div>
      <div className="flex-shrink-0 self-center min-w-[180px] flex justify-end">{control}</div>
    </div>
  );
}

function Block({
  title,
  hint,
  children,
  footer,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element {
  return (
    <section className="bg-surface-container/60 rounded-2xl border border-outline-variant/10 overflow-hidden">
      <header className="px-6 pt-5 pb-3 flex items-baseline justify-between gap-4">
        <h2 className="font-headline font-bold text-[12px] uppercase tracking-[0.2em] text-on-surface-variant/60">{title}</h2>
        {hint && <span className="font-body text-[11px] text-on-surface-variant/35 max-w-md text-right hidden md:block">{hint}</span>}
      </header>
      <div className="divide-y divide-outline-variant/10">{children}</div>
      {footer && <div className="px-6 py-4 border-t border-outline-variant/10 bg-surface-container-low/40">{footer}</div>}
    </section>
  );
}

// ── controls ─────────────────────────────────────────────────
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors ${checked ? "bg-primary-container" : "bg-surface-container-highest"}`}
    >
      <span
        className={`absolute top-[2px] left-[2px] w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`}
      />
    </button>
  );
}

function Segment<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: ReadonlyArray<{ v: T; l: string }>;
  onChange: (v: T) => void;
  size?: "sm" | "md";
}): JSX.Element {
  const padding = size === "sm" ? "px-2.5 py-1 text-[10px]" : "px-3 py-1.5 text-[11px]";
  return (
    <div className="inline-flex bg-surface-container-high rounded-lg p-1 border border-outline-variant/10">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`${padding} font-label uppercase tracking-wider rounded-md transition-all ${
            value === o.v ? "bg-primary-container text-on-primary-container shadow-sm" : "text-on-surface-variant/70 hover:text-on-surface"
          }`}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function PathControl({
  value,
  onPick,
  onClear,
}: {
  value: string;
  onPick: () => void;
  onClear: () => void;
}): JSX.Element {
  const isEmpty = !value;
  return (
    <div className="flex items-center gap-2 w-[320px]">
      <div
        className={`flex-1 bg-surface-container-high rounded-lg px-3 py-2 text-[12px] font-label truncate border border-outline-variant/10 ${
          isEmpty ? "text-on-surface-variant/35" : "text-on-surface"
        }`}
        title={value || undefined}
      >
        {value || "默认: 应用同级目录"}
      </div>
      {!isEmpty && (
        <button
          onClick={onClear}
          className="w-9 h-9 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant/60 hover:text-on-surface flex items-center justify-center transition-colors"
          title="清空"
        >
          <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>close</span>
        </button>
      )}
      <button
        onClick={onPick}
        className="w-9 h-9 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant/80 hover:text-on-surface flex items-center justify-center transition-colors"
        title="选择文件夹"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>drive_folder_upload</span>
      </button>
    </div>
  );
}

function TextControl({
  value,
  placeholder,
  type = "text",
  onChange,
  onCommit,
  trailing,
}: {
  value: string;
  placeholder?: string;
  type?: "text" | "password";
  onChange: (v: string) => void;
  /** Called when input loses focus or Enter is pressed — natural commit point for auto-save. */
  onCommit?: () => void;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <div className="bg-surface-container-high text-on-surface text-[12px] font-label rounded-lg pl-3 pr-2 border border-outline-variant/10 hover:border-outline-variant/25 focus-within:border-primary-container/40 transition-colors w-[280px] flex items-center gap-2">
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => { if (e.key === "Enter" && onCommit) onCommit(); }}
        spellCheck={false}
        autoComplete="off"
        className="flex-1 bg-transparent py-2 outline-none placeholder-on-surface-variant/30"
      />
      {trailing}
    </div>
  );
}

function ReadonlyValue({ value }: { value: string }): JSX.Element {
  return <span className="font-label text-[12px] text-on-surface-variant/80 tabular-nums">{value}</span>;
}

// ── header (sticky) ──────────────────────────────────────────
function SettingsHeader({
  onBack,
  onOpenTweaks,
}: {
  onBack: () => void;
  onOpenTweaks: () => void;
}): JSX.Element {
  const { diskFreeLabel, activeTasks, networkOnline, speedLabel } = useSystemStats();
  return (
    <header className="sticky top-0 z-40 bg-background/85 backdrop-blur-xl border-b border-outline-variant/10">
      <div className="h-14 px-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="w-8 h-8 rounded-lg hover:bg-on-surface/[0.04] flex items-center justify-center text-on-surface-variant"
            title="返回"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 18 }}>arrow_back</span>
          </button>
          <div className="flex items-center gap-2 font-label text-[10px] uppercase tracking-[0.25em] text-on-surface-variant/60">
            <span className="text-on-surface/80">Dashboard</span>
            <span className="text-on-surface-variant/30">/</span>
            <span>System Preferences</span>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <Stat icon="storage" label={diskFreeLabel} />
          <Stat icon="downloading" label={`${activeTasks} TASKS`} active={activeTasks > 0} />
          <Stat icon="speed" label={speedLabel} />
          <div className={`flex items-center gap-1.5 ${networkOnline ? "text-green-400" : "text-red-500"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${networkOnline ? "bg-green-400 animate-pulse" : "bg-red-500"}`} />
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>{networkOnline ? "wifi_tethering" : "wifi_off"}</span>
            <span className="font-label text-[10px] tracking-widest uppercase">{networkOnline ? "Online" : "Offline"}</span>
          </div>
          <span className="h-4 w-px bg-outline-variant/20" />
          <button
            onClick={onOpenTweaks}
            className="w-8 h-8 rounded-lg hover:bg-on-surface/[0.04] flex items-center justify-center text-on-surface-variant"
            title="界面调节"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>tune</span>
          </button>
        </div>
      </div>
    </header>
  );
}

function Stat({ icon, label, active }: { icon: string; label: string; active?: boolean }): JSX.Element {
  return (
    <div className={`flex items-center gap-1.5 ${active ? "text-primary" : "text-on-surface-variant/60"}`}>
      <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>{icon}</span>
      <span className="font-label text-[10px] tracking-widest uppercase">{label}</span>
    </div>
  );
}

// ── category nav (rail or tabs based on tweak) ───────────────
function CategoryRail({
  active,
  onSelect,
}: {
  active: CategoryId;
  onSelect: (id: CategoryId) => void;
}): JSX.Element {
  return (
    <aside className="w-[260px] flex-shrink-0 border-r border-outline-variant/10 bg-surface-container-low/30 flex flex-col">
      <div className="px-6 pt-8 pb-5">
        <div className="font-label text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/40 mb-2">Settings</div>
        <h1 className="font-headline font-black text-[28px] tracking-tight text-on-surface leading-none">
          系统偏好<span className="text-primary-container">.</span>
        </h1>
      </div>
      <nav className="px-3 flex-1 overflow-y-auto custom-scrollbar pb-6">
        {CATEGORIES.map((c) => {
          const isActive = active === c.id;
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-lg mb-0.5 text-left transition-colors ${
                isActive
                  ? "bg-primary-container/15 text-on-surface"
                  : "text-on-surface-variant/70 hover:bg-on-surface/[0.04] hover:text-on-surface"
              }`}
            >
              <span
                className={`material-symbols-outlined leading-none flex-shrink-0 ${isActive ? "text-primary-container" : ""}`}
                style={{ fontSize: 18 }}
              >
                {c.icon}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-headline font-semibold leading-tight truncate">{c.label}</span>
                <span className="block text-[10px] font-label uppercase tracking-widest text-on-surface-variant/40 leading-tight mt-0.5">
                  {c.en}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="px-6 py-5 border-t border-outline-variant/10">
        <div className="flex items-center gap-2 text-on-surface-variant/40">
          <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>fingerprint</span>
          <span className="font-label text-[10px] tracking-widest uppercase">{NODE_ID}</span>
        </div>
        <div className="font-label text-[10px] tracking-widest uppercase text-on-surface-variant/30 mt-1.5">
          MapleTools v{__APP_VERSION__}
        </div>
      </div>
    </aside>
  );
}

function CategoryTabs({
  active,
  onSelect,
}: {
  active: CategoryId;
  onSelect: (id: CategoryId) => void;
}): JSX.Element {
  return (
    <div className="border-b border-outline-variant/10 bg-surface-container-low/40 sticky top-0 z-30 backdrop-blur-xl">
      <div className="px-8 flex items-center gap-1 overflow-x-auto custom-scrollbar">
        {CATEGORIES.map((c) => {
          const isActive = active === c.id;
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`relative flex items-center gap-2 px-4 py-3 text-[13px] font-label uppercase tracking-wider whitespace-nowrap transition-colors ${
                isActive ? "text-on-surface" : "text-on-surface-variant/55 hover:text-on-surface"
              }`}
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>{c.icon}</span>
              {c.en}
              {isActive && <span className="absolute left-3 right-3 -bottom-px h-0.5 bg-primary-container rounded-full" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Tweaks floating panel ────────────────────────────────────
function TweaksPanel({
  tweaks,
  setTweak,
  onClose,
  isDark,
  setIsDark,
}: {
  tweaks: Tweaks;
  setTweak: <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void;
  onClose: () => void;
  isDark: boolean;
  setIsDark: (v: boolean) => void;
}): JSX.Element {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed top-16 right-6 z-50 w-[300px] bg-surface-container-high/95 backdrop-blur-xl border border-outline-variant/15 rounded-2xl shadow-2xl">
        <div className="px-5 py-4 flex items-center justify-between border-b border-outline-variant/10">
          <span className="font-label text-[11px] uppercase tracking-[0.25em] text-on-surface-variant">Tweaks</span>
          <button onClick={onClose} className="text-on-surface-variant/60 hover:text-on-surface">
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
        <div className="p-5 space-y-5">
          <TweakRadio
            label="主题"
            value={isDark ? "dark" : "light"}
            options={[
              { v: "light", l: "浅色" },
              { v: "dark", l: "深色" },
            ]}
            onChange={(v) => setIsDark(v === "dark")}
          />
          <TweakRadio
            label="导航样式"
            value={tweaks.navStyle}
            options={[
              { v: "rail", l: "侧边栏" },
              { v: "tabs", l: "顶部标签" },
            ]}
            onChange={(v) => setTweak("navStyle", v as NavStyle)}
          />
          <TweakRadio
            label="界面密度"
            value={tweaks.density}
            options={[
              { v: "compact", l: "紧凑" },
              { v: "comfortable", l: "舒适" },
              { v: "spacious", l: "宽松" },
            ]}
            onChange={(v) => setTweak("density", v as Density)}
          />
        </div>
      </div>
    </>
  );
}

function TweakRadio({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ v: string; l: string }>;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <div>
      <div className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 mb-2">{label}</div>
      <div className="inline-flex bg-surface-container rounded-lg p-0.5 w-full border border-outline-variant/10">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className={`flex-1 text-[11px] py-1.5 rounded-md transition-all ${
              value === o.v
                ? "bg-primary-container text-on-primary-container font-bold"
                : "text-on-surface-variant/70 hover:text-on-surface"
            }`}
          >
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── main component ───────────────────────────────────────────
function Settings(): JSX.Element {
  const navigate = useNavigate();

  // Active category, persisted across sessions.
  const [active, setActive] = useState<CategoryId>(() => {
    const v = localStorage.getItem(ACTIVE_CATEGORY_KEY) as CategoryId | null;
    return v && CATEGORIES.some((c) => c.id === v) ? v : "general";
  });
  useEffect(() => { localStorage.setItem(ACTIVE_CATEGORY_KEY, active); }, [active]);

  // Settings — auto-save on every change.
  const [settings, setSettingsState] = useState<Required<SavedSettings>>(readSavedSettings);
  const updateSettings = (patch: Partial<Required<SavedSettings>>): void => {
    const next = { ...settings, ...patch };
    setSettingsState(next);
    writeSettings(next);
    if (patch.minimizeOnClose !== undefined) {
      window.systemApi.setSetting?.("minimizeOnClose", patch.minimizeOnClose).catch(() => {});
    }
  };

  // WebDAV — auto-save on commit (Enter / blur).
  const [webdavAccount, setWebdavAccount] = useState("");
  const [webdavPassword, setWebdavPassword] = useState("");
  const [webdavPath, setWebdavPath] = useState("MapleTools/homework.json");
  const [webdavShowPwd, setWebdavShowPwd] = useState(false);
  const [webdavTestState, setWebdavTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [webdavTestMsg, setWebdavTestMsg] = useState("");
  const lastSavedWebdav = useRef({ account: "", password: "", path: "MapleTools/homework.json" });

  useEffect(() => {
    window.webdavApi
      .getConfig()
      .then((cfg) => {
        if (!cfg) return;
        setWebdavAccount(cfg.account);
        setWebdavPassword(cfg.appPassword);
        const p = cfg.remotePath || "MapleTools/homework.json";
        setWebdavPath(p);
        lastSavedWebdav.current = { account: cfg.account, password: cfg.appPassword, path: p };
      })
      .catch(() => {});
  }, []);

  const persistWebdav = (): void => {
    const cur = { account: webdavAccount.trim(), appPassword: webdavPassword, remotePath: webdavPath.trim() };
    const last = lastSavedWebdav.current;
    if (cur.account === last.account && cur.appPassword === last.password && cur.remotePath === last.path) {
      return; // unchanged — skip the IPC roundtrip
    }
    window.webdavApi.saveConfig(cur).then(() => {
      lastSavedWebdav.current = { account: cur.account, password: cur.appPassword, path: cur.remotePath };
    }).catch(() => {});
  };

  // Tweaks (UI meta-controls), persisted.
  const [tweaks, setTweaks] = useState<Tweaks>(readTweaks);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const setTweak = <K extends keyof Tweaks>(k: K, v: Tweaks[K]): void => {
    setTweaks((t) => {
      const next = { ...t, [k]: v };
      try { localStorage.setItem(TWEAKS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // Theme — same global state as the rest of the app uses.
  const [isDark, setIsDark] = useState(() => {
    const stored = localStorage.getItem("theme");
    if (stored) return stored === "dark";
    return document.documentElement.classList.contains("dark");
  });
  const applyDark = (next: boolean): void => {
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
    setIsDark(next);
  };

  const handlePickDownloadFolder = async (): Promise<void> => {
    const picked = await window.systemApi.pickFolder();
    if (!picked) return;
    updateSettings({ downloadPath: picked });
  };

  const handleWebdavTest = async (): Promise<void> => {
    setWebdavTestState("testing");
    setWebdavTestMsg("");
    try {
      const cur = { account: webdavAccount.trim(), appPassword: webdavPassword, remotePath: webdavPath.trim() };
      await window.webdavApi.saveConfig(cur);
      lastSavedWebdav.current = { account: cur.account, password: cur.appPassword, path: cur.remotePath };
      await window.webdavApi.test();
      setWebdavTestState("ok");
      setWebdavTestMsg("连接成功");
    } catch (e: unknown) {
      setWebdavTestState("error");
      setWebdavTestMsg(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': /, "") : "连接失败");
    }
    setTimeout(() => { setWebdavTestState("idle"); setWebdavTestMsg(""); }, 4000);
  };

  const cat = CATEGORIES.find((c) => c.id === active)!;
  const useTabs = tweaks.navStyle === "tabs";

  return (
    <div className="h-full flex flex-col bg-background relative">
      <SettingsHeader
        onBack={() => navigate(-1)}
        onOpenTweaks={() => setTweaksOpen((o) => !o)}
      />

      <div className="flex flex-1 min-h-0">
        {!useTabs && <CategoryRail active={active} onSelect={setActive} />}

        <main className="flex-1 overflow-y-auto custom-scrollbar">
          {useTabs && <CategoryTabs active={active} onSelect={setActive} />}

          <div className="max-w-3xl mx-auto px-8 py-10 pb-16">
            {/* Category header */}
            <div key={active} className="mb-8 animate-fade-in">
              <div className="flex items-center gap-2 font-label text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/40 mb-3">
                <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>{cat.icon}</span>
                {cat.en}
              </div>
              <h2 className="font-headline font-black text-[40px] tracking-tight text-on-surface leading-[1.05]">
                {cat.label}
                <span className="text-primary-container">.</span>
              </h2>
              <p className="font-body text-[14px] text-on-surface-variant/55 mt-2 max-w-xl">{cat.desc}</p>
            </div>

            {/* Blocks */}
            <div className="space-y-5">
              {active === "general" && (
                <Block title="搜索与缓存">
                  <Row
                    icon="cached"
                    title="启用搜索缓存"
                    desc="已搜索过的标题将从本地即时加载；禁用则每次都重新抓取。"
                    density={tweaks.density}
                    control={
                      <Switch
                        checked={settings.searchCacheEnabled}
                        onChange={(v) => updateSettings({ searchCacheEnabled: v })}
                      />
                    }
                  />
                  <Row
                    icon="minimize"
                    title="关闭到托盘"
                    desc="点击关闭按钮时隐藏窗口到系统托盘。单击托盘图标可重新显示。"
                    density={tweaks.density}
                    control={
                      <Switch
                        checked={settings.minimizeOnClose}
                        onChange={(v) => updateSettings({ minimizeOnClose: v })}
                      />
                    }
                  />
                </Block>
              )}

              {active === "downloads" && (
                <Block
                  title="保存路径"
                  hint="文件保存到 <path>/<title>/。留空时使用应用同级目录。"
                >
                  <Row
                    icon="folder_open"
                    title="默认下载目录"
                    desc="影响所有源（西番 / Girigiri / 嗷呜）的默认保存位置。"
                    density={tweaks.density}
                    control={
                      <PathControl
                        value={settings.downloadPath}
                        onPick={handlePickDownloadFolder}
                        onClear={() => updateSettings({ downloadPath: "" })}
                      />
                    }
                  />
                </Block>
              )}

              {active === "sync" && (
                <Block
                  title="坚果云 WebDAV"
                  hint="应用密码在坚果云「账号信息 → 安全选项 → 第三方应用管理」生成。"
                  footer={
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleWebdavTest}
                        disabled={webdavTestState === "testing"}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-outline-variant/20 hover:bg-on-surface/[0.04] disabled:opacity-50 text-on-surface text-[12px] font-label uppercase tracking-wider transition-colors"
                      >
                        <span
                          className={`material-symbols-outlined leading-none ${webdavTestState === "testing" ? "animate-spin" : ""}`}
                          style={{ fontSize: 16 }}
                        >
                          {webdavTestState === "ok" ? "check_circle" : webdavTestState === "error" ? "error" : "wifi_find"}
                        </span>
                        {webdavTestState === "testing" ? "测试中…" : webdavTestState === "ok" ? "连接成功" : "测试连接"}
                      </button>
                      {webdavTestMsg && (
                        <span className={`font-label text-[11px] ${webdavTestState === "ok" ? "text-tertiary" : "text-error"}`}>
                          {webdavTestMsg}
                        </span>
                      )}
                    </div>
                  }
                >
                  <Row
                    icon="account_circle"
                    title="账号（注册邮箱）"
                    desc="登录坚果云的邮箱地址。"
                    density={tweaks.density}
                    control={
                      <TextControl
                        value={webdavAccount}
                        placeholder="example@email.com"
                        onChange={setWebdavAccount}
                        onCommit={persistWebdav}
                      />
                    }
                  />
                  <Row
                    icon="key"
                    title="应用密码"
                    desc="坚果云后台生成的第三方应用密码（不是登录密码）。"
                    density={tweaks.density}
                    control={
                      <TextControl
                        value={webdavPassword}
                        placeholder="••••••••"
                        type={webdavShowPwd ? "text" : "password"}
                        onChange={setWebdavPassword}
                        onCommit={persistWebdav}
                        trailing={
                          <button
                            onClick={() => setWebdavShowPwd((v) => !v)}
                            className="text-on-surface-variant/40 hover:text-on-surface transition-colors flex-shrink-0 px-1"
                            type="button"
                          >
                            <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>
                              {webdavShowPwd ? "visibility_off" : "visibility"}
                            </span>
                          </button>
                        }
                      />
                    }
                  />
                  <Row
                    icon="folder_zip"
                    title="远程文件路径"
                    desc="相对于 WebDAV 根目录，文件夹不存在时自动创建。"
                    density={tweaks.density}
                    control={
                      <TextControl
                        value={webdavPath}
                        placeholder="MapleTools/homework.json"
                        onChange={setWebdavPath}
                        onCommit={persistWebdav}
                      />
                    }
                  />
                </Block>
              )}

              {active === "appearance" && (
                <Block title="主题">
                  <Row
                    icon="contrast"
                    title="颜色模式"
                    desc="深色与浅色之间切换，立即生效。"
                    density={tweaks.density}
                    control={
                      <Segment
                        value={isDark ? "dark" : "light"}
                        options={[
                          { v: "light", l: "浅色" },
                          { v: "dark", l: "深色" },
                        ]}
                        onChange={(v) => applyDark(v === "dark")}
                      />
                    }
                  />
                </Block>
              )}

              {active === "about" && (
                <Block title="应用信息">
                  <Row
                    icon="package_2"
                    title="版本"
                    desc="当前已安装的应用版本。"
                    density={tweaks.density}
                    control={<ReadonlyValue value={`MapleTools v${__APP_VERSION__}`} />}
                  />
                  <Row
                    icon="devices"
                    title="运行平台"
                    desc="操作系统类型。"
                    density={tweaks.density}
                    control={<ReadonlyValue value={PLATFORM} />}
                  />
                  <Row
                    icon="fingerprint"
                    title="节点 ID"
                    desc="本机匿名标识符（仅本地，不上传）。"
                    density={tweaks.density}
                    control={<ReadonlyValue value={NODE_ID} />}
                  />
                </Block>
              )}
            </div>

            {/* Auto-save badge */}
            <div className="pt-6 flex items-center gap-2.5 text-on-surface-variant/30">
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>cloud_done</span>
              <span className="font-label text-[10px] uppercase tracking-widest">设置已自动保存并实时生效</span>
            </div>
          </div>
        </main>
      </div>

      {tweaksOpen && (
        <TweaksPanel
          tweaks={tweaks}
          setTweak={setTweak}
          onClose={() => setTweaksOpen(false)}
          isDark={isDark}
          setIsDark={applyDark}
        />
      )}
    </div>
  );
}

export default Settings;
