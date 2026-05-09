import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useSystemStats } from "../hooks/useSystemStats";
import { navGuard } from "../utils/navGuard";
import { ipcErrMsg } from "../utils/ipcError";

// ── constants ────────────────────────────────────────────────
const NODE_ID_KEY = "xifan_node_id";
const SETTINGS_KEY = "xifan_settings";
const ACTIVE_CATEGORY_KEY = "maple-settings-category";

interface HistoryEntry {
  text: string;
  time: number;
}

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
      minimizeOnClose: s.minimizeOnClose ?? DEFAULTS.minimizeOnClose,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function formatHistoryTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
  { id: "about", label: "关于", en: "About", icon: "info", desc: "版本、节点与最近更改" },
];

// ── reusable Row primitive ───────────────────────────────────
function Row({
  icon,
  title,
  desc,
  control,
}: {
  icon: string;
  title: string;
  desc: string;
  control: ReactNode;
}): JSX.Element {
  return (
    <div className="group flex items-start gap-5 px-6 py-5 hover:bg-on-surface/[0.015] transition-colors">
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

// ── Controls ─────────────────────────────────────────────────
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
}: {
  value: T;
  options: ReadonlyArray<{ v: T; l: string }>;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div className="inline-flex bg-surface-container-high rounded-lg p-1 border border-outline-variant/10">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-3 py-1.5 text-[11px] font-label uppercase tracking-wider rounded-md transition-all ${
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
  trailing,
}: {
  value: string;
  placeholder?: string;
  type?: "text" | "password";
  onChange: (v: string) => void;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <div className="bg-surface-container-high text-on-surface text-[12px] font-label rounded-lg pl-3 pr-2 border border-outline-variant/10 hover:border-outline-variant/25 focus-within:border-primary-container/40 transition-colors w-[280px] flex items-center gap-2">
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
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

// ── Header (system stats + theme toggle + back) ──────────────
function SettingsHeader({
  isDirty,
  onBack,
  onToggleTheme,
  isDark,
}: {
  isDirty: boolean;
  onBack: () => void;
  onToggleTheme: () => void;
  isDark: boolean;
}): JSX.Element {
  const { diskFreeLabel, activeTasks, networkOnline, speedLabel } = useSystemStats();
  return (
    <header className="fixed top-0 right-0 left-64 z-40 bg-background/85 backdrop-blur-xl border-b border-outline-variant/10">
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
            {isDirty && (
              <>
                <span className="text-on-surface-variant/30">·</span>
                <span className="text-yellow-400 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                  Unsaved
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-5">
          <Stat icon="storage" label={diskFreeLabel} />
          <Stat icon="downloading" label={`${activeTasks} TASKS`} active={activeTasks > 0} />
          <Stat icon="speed" label={speedLabel} />
          <div className={`flex items-center gap-1.5 ${networkOnline ? "text-tertiary" : "text-error"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${networkOnline ? "bg-tertiary animate-pulse" : "bg-error"}`} />
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>{networkOnline ? "wifi_tethering" : "wifi_off"}</span>
            <span className="font-label text-[10px] tracking-widest uppercase">{networkOnline ? "Online" : "Offline"}</span>
          </div>
          <span className="h-4 w-px bg-outline-variant/20" />
          <button
            onClick={onToggleTheme}
            className="w-8 h-8 rounded-lg hover:bg-on-surface/[0.04] flex items-center justify-center text-on-surface-variant"
            title="切换主题"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>{isDark ? "light_mode" : "dark_mode"}</span>
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

// ── Left rail (category nav) ─────────────────────────────────
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

// ── Main component ───────────────────────────────────────────
function Settings(): JSX.Element {
  const navigate = useNavigate();

  // Active category, persisted across sessions.
  const [active, setActive] = useState<CategoryId>(() => {
    const v = localStorage.getItem(ACTIVE_CATEGORY_KEY) as CategoryId | null;
    return v && CATEGORIES.some((c) => c.id === v) ? v : "general";
  });
  useEffect(() => { localStorage.setItem(ACTIVE_CATEGORY_KEY, active); }, [active]);

  // Staged form (only committed on Save) — preserves the existing dirty-state UX.
  const [staged, setStaged] = useState<Required<SavedSettings>>(readSavedSettings);
  const [saved, setSaved] = useState<Required<SavedSettings>>(readSavedSettings);

  // WebDAV — separate from the main saved bundle (its own IPC path)
  const [webdavAccount, setWebdavAccount] = useState("");
  const [webdavPassword, setWebdavPassword] = useState("");
  const [webdavPath, setWebdavPath] = useState("MapleTools/homework.json");
  const [webdavOriginal, setWebdavOriginal] = useState({ account: "", password: "", path: "MapleTools/homework.json" });
  const [webdavShowPwd, setWebdavShowPwd] = useState(false);
  const [webdavTestState, setWebdavTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [webdavTestMsg, setWebdavTestMsg] = useState("");

  useEffect(() => {
    window.webdavApi
      .getConfig()
      .then((cfg) => {
        if (!cfg) return;
        setWebdavAccount(cfg.account);
        setWebdavPassword(cfg.appPassword);
        setWebdavPath(cfg.remotePath || "MapleTools/homework.json");
        setWebdavOriginal({
          account: cfg.account,
          password: cfg.appPassword,
          path: cfg.remotePath || "MapleTools/homework.json",
        });
      })
      .catch(() => {});
  }, []);

  const isDirty = useMemo(() => {
    const a = staged;
    const b = saved;
    return (
      a.downloadPath !== b.downloadPath ||
      a.searchCacheEnabled !== b.searchCacheEnabled ||
      a.minimizeOnClose !== b.minimizeOnClose ||
      webdavAccount !== webdavOriginal.account ||
      webdavPassword !== webdavOriginal.password ||
      webdavPath !== webdavOriginal.path
    );
  }, [staged, saved, webdavAccount, webdavPassword, webdavPath, webdavOriginal]);

  // Theme toggle (persisted via the same `theme` key the rest of the app uses)
  const [isDark, setIsDark] = useState(() => {
    const stored = localStorage.getItem("theme");
    if (stored) return stored === "dark";
    return document.documentElement.classList.contains("dark");
  });
  const toggleTheme = (): void => {
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

  // History (last 20 changes; we display 5)
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    window.systemApi.loadSettingsHistory().then(setHistoryEntries).catch(() => {});
  }, []);

  // pendingNav: where to go after the dirty-warn dialog resolves ('__back__' for back nav)
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  useEffect(() => {
    if (isDirty) navGuard.setListener((to) => setPendingNav(to));
    else navGuard.setListener(null);
    return () => navGuard.setListener(null);
  }, [isDirty]);

  const recordChange = (text: string): void => {
    const updated = [{ text, time: Date.now() }, ...historyEntries].slice(0, 20);
    setHistoryEntries(updated);
    window.systemApi.saveSettingsHistory(updated).catch(() => {});
  };

  const handleSave = (): void => {
    const current = readSavedSettings();
    const changes: string[] = [];
    if (staged.downloadPath !== current.downloadPath) {
      changes.push(staged.downloadPath ? `下载路径 → ${staged.downloadPath}` : "下载路径已清空");
    }
    if (staged.searchCacheEnabled !== current.searchCacheEnabled) {
      changes.push(`搜索缓存 ${staged.searchCacheEnabled ? "已启用" : "已禁用"}`);
    }
    if (staged.minimizeOnClose !== current.minimizeOnClose) {
      changes.push(`关闭到托盘 ${staged.minimizeOnClose ? "已启用" : "已禁用"}`);
      window.systemApi.setSetting?.("minimizeOnClose", staged.minimizeOnClose).catch(() => {});
    }
    if (
      webdavAccount !== webdavOriginal.account ||
      webdavPassword !== webdavOriginal.password ||
      webdavPath !== webdavOriginal.path
    ) {
      changes.push("WebDAV 配置已更新");
    }

    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          downloadPath: staged.downloadPath || undefined,
          searchCacheEnabled: staged.searchCacheEnabled,
          minimizeOnClose: staged.minimizeOnClose,
        }),
      );
    } catch { /* ignore */ }

    window.webdavApi
      .saveConfig({
        account: webdavAccount.trim(),
        appPassword: webdavPassword,
        remotePath: webdavPath.trim(),
      })
      .catch(() => {});

    setSaved({ ...staged });
    setWebdavOriginal({ account: webdavAccount, password: webdavPassword, path: webdavPath });
    if (changes.length > 0) recordChange(changes.join(" · "));
    setSaveLabel("saved");
    setTimeout(() => setSaveLabel("save"), 1800);
  };

  const handleReset = (): void => {
    setStaged({ ...DEFAULTS });
    setWebdavAccount(webdavOriginal.account);
    setWebdavPassword(webdavOriginal.password);
    setWebdavPath(webdavOriginal.path);
  };

  const handleProceedNav = (save: boolean): void => {
    if (save) handleSave();
    navGuard.setListener(null);
    if (pendingNav === "__back__") navigate(-1);
    else if (pendingNav) navigate(pendingNav);
    setPendingNav(null);
  };

  const [saveLabel, setSaveLabel] = useState<"save" | "saved">("save");

  const handlePickDownloadFolder = async (): Promise<void> => {
    const picked = await window.systemApi.pickFolder();
    if (!picked) return;
    setStaged((s) => ({ ...s, downloadPath: picked }));
  };

  const handleWebdavTest = async (): Promise<void> => {
    setWebdavTestState("testing");
    setWebdavTestMsg("");
    try {
      await window.webdavApi.saveConfig({
        account: webdavAccount.trim(),
        appPassword: webdavPassword,
        remotePath: webdavPath.trim(),
      });
      await window.webdavApi.test();
      setWebdavOriginal({ account: webdavAccount, password: webdavPassword, path: webdavPath });
      setWebdavTestState("ok");
      setWebdavTestMsg("连接成功并已写入配置");
    } catch (e: unknown) {
      setWebdavTestState("error");
      setWebdavTestMsg(ipcErrMsg(e, "连接失败"));
    }
    setTimeout(() => { setWebdavTestState("idle"); setWebdavTestMsg(""); }, 4000);
  };

  const cat = CATEGORIES.find((c) => c.id === active)!;

  return (
    <div className="min-h-full bg-surface">
      <SettingsHeader
        isDirty={isDirty}
        onBack={() => (isDirty ? setPendingNav("__back__") : navigate(-1))}
        onToggleTheme={toggleTheme}
        isDark={isDark}
      />

      <div className="pt-14 flex min-h-[calc(100vh-3.5rem)]">
        <CategoryRail active={active} onSelect={setActive} />

        <main className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="max-w-3xl mx-auto px-8 py-10 pb-32">
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
                    control={
                      <Switch
                        checked={staged.searchCacheEnabled}
                        onChange={(v) => setStaged((s) => ({ ...s, searchCacheEnabled: v }))}
                      />
                    }
                  />
                  <Row
                    icon="minimize"
                    title="关闭到托盘"
                    desc="点击关闭按钮时隐藏窗口到系统托盘。单击托盘图标可重新显示。"
                    control={
                      <Switch
                        checked={staged.minimizeOnClose}
                        onChange={(v) => setStaged((s) => ({ ...s, minimizeOnClose: v }))}
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
                    control={
                      <PathControl
                        value={staged.downloadPath}
                        onPick={handlePickDownloadFolder}
                        onClear={() => setStaged((s) => ({ ...s, downloadPath: "" }))}
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
                          {webdavTestState === "ok"
                            ? "check_circle"
                            : webdavTestState === "error"
                              ? "error"
                              : "wifi_find"}
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
                    control={
                      <TextControl
                        value={webdavAccount}
                        placeholder="example@email.com"
                        onChange={setWebdavAccount}
                      />
                    }
                  />
                  <Row
                    icon="key"
                    title="应用密码"
                    desc="坚果云后台生成的第三方应用密码（不是登录密码）。"
                    control={
                      <TextControl
                        value={webdavPassword}
                        placeholder="••••••••"
                        type={webdavShowPwd ? "text" : "password"}
                        onChange={setWebdavPassword}
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
                    control={
                      <TextControl
                        value={webdavPath}
                        placeholder="MapleTools/homework.json"
                        onChange={setWebdavPath}
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
                    desc="深色与浅色之间切换。设置立即生效，无需保存。"
                    control={
                      <Segment
                        value={isDark ? "dark" : "light"}
                        options={[
                          { v: "light", l: "浅色" },
                          { v: "dark", l: "深色" },
                        ]}
                        onChange={(v) => {
                          if (v === "dark" && !isDark) toggleTheme();
                          if (v === "light" && isDark) toggleTheme();
                        }}
                      />
                    }
                  />
                </Block>
              )}

              {active === "about" && (
                <>
                  <Block title="应用信息">
                    <Row icon="package_2" title="版本" desc="当前已安装的应用版本。" control={<ReadonlyValue value={`MapleTools v${__APP_VERSION__}`} />} />
                    <Row icon="devices" title="运行平台" desc="操作系统类型。" control={<ReadonlyValue value={PLATFORM} />} />
                    <Row icon="fingerprint" title="节点 ID" desc="本机匿名标识符（仅本地，不上传）。" control={<ReadonlyValue value={NODE_ID} />} />
                  </Block>
                  <Block title="最近更改">
                    <div className="px-6 py-5">
                      {historyEntries.length === 0 ? (
                        <p className="font-label text-[11px] text-on-surface-variant/30 uppercase tracking-widest">暂无更改记录</p>
                      ) : (
                        <ul className="space-y-3">
                          {historyEntries.slice(0, 5).map((entry, i) => (
                            <li key={i} className="flex items-start gap-3 group">
                              <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary/40 group-hover:bg-primary transition-colors flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="font-body text-[12px] text-on-surface/85 leading-snug break-all">{entry.text}</p>
                                <p className="font-label text-[10px] text-on-surface-variant/40 tracking-wider mt-0.5">{formatHistoryTime(entry.time)}</p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </Block>
                </>
              )}
            </div>

            {/* Tail status — same vibe as mockup's "已自动保存" but honest about staged */}
            <div className="pt-6 flex items-center gap-2.5 text-on-surface-variant/30">
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>
                {isDirty ? "edit" : "cloud_done"}
              </span>
              <span className="font-label text-[10px] uppercase tracking-widest">
                {isDirty ? "有未保存的更改" : "所有更改已保存"}
              </span>
            </div>
          </div>
        </main>
      </div>

      {/* Sticky save bar — slides up when there are staged changes. */}
      <div
        className={`fixed bottom-0 left-64 right-0 z-30 transition-transform duration-200 ${
          isDirty ? "translate-y-0" : "translate-y-full pointer-events-none"
        }`}
      >
        <div className="bg-surface-container-high/95 backdrop-blur-xl border-t border-outline-variant/15">
          <div className="max-w-3xl mx-auto px-8 py-3 flex items-center gap-4">
            <span className="flex items-center gap-2 font-label text-[11px] uppercase tracking-widest text-yellow-400">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              有未保存的更改
            </span>
            <span className="flex-1" />
            <button
              onClick={handleReset}
              className="px-4 h-9 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-on-surface/[0.04] font-label text-[11px] uppercase tracking-widest transition-colors"
            >
              撤销修改
            </button>
            <button
              onClick={handleSave}
              className="px-5 h-9 rounded-lg bg-primary-container text-on-primary-container font-headline font-bold text-[12px] uppercase tracking-wider hover:brightness-110 active:brightness-95 transition-all flex items-center gap-2 shadow-lg shadow-primary/10"
            >
              {saveLabel === "saved" && (
                <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>check</span>
              )}
              {saveLabel === "save" ? "保存修改" : "已保存"}
            </button>
          </div>
        </div>
      </div>

      {/* Unsaved-changes navigation warning */}
      {pendingNav !== null && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/40"
          onClick={() => setPendingNav(null)}
        >
          <div
            className="w-full max-w-md bg-surface-container-high/95 backdrop-blur-2xl rounded-2xl p-8 border border-outline-variant/15 shadow-[0_40px_80px_rgba(0,0,0,0.5)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-4 mb-6">
              <div className="w-10 h-10 rounded-lg bg-yellow-400/15 border border-yellow-400/25 flex items-center justify-center flex-shrink-0">
                <span className="material-symbols-outlined text-yellow-400 leading-none" style={{ fontSize: 22 }}>warning_amber</span>
              </div>
              <div>
                <h2 className="font-headline font-black text-lg text-on-surface tracking-tight">有未保存的更改</h2>
                <p className="font-body text-[13px] text-on-surface-variant/70 mt-1.5">现在离开会丢弃这些改动。</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => handleProceedNav(false)}
                className="flex-1 py-3 rounded-lg border border-outline-variant/20 text-on-surface-variant hover:text-on-surface hover:bg-on-surface/[0.04] font-label text-[11px] uppercase tracking-wider transition-colors"
              >
                丢弃并离开
              </button>
              <button
                onClick={() => handleProceedNav(true)}
                className="flex-1 py-3 rounded-lg bg-primary-container text-on-primary-container font-headline font-bold text-[12px] uppercase tracking-wider hover:brightness-110 transition-all"
              >
                保存并离开
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Settings;
