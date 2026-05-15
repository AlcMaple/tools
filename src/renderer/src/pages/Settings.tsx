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

type CategoryId = "general" | "downloads" | "sync" | "notify" | "appearance" | "about";

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
  { id: "notify", label: "邮件提醒", en: "Mail", icon: "outgoing_mail", desc: "周历刷新后自动发送 QQ 邮件" },
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
  defaultPath,
  onPick,
  onClear,
  onReveal,
}: {
  value: string;
  /** OS-default downloads folder, shown as a faded preview when value is empty. */
  defaultPath: string;
  onPick: () => void;
  onClear: () => void;
  /** Open the effective path in the OS file manager (Finder/Explorer). */
  onReveal: () => void;
}): JSX.Element {
  const isEmpty = !value;
  // 留空时显示真实的系统默认下载目录（path.getPath('downloads')），不再骗用户
  // 说"应用同级目录"。defaultPath 异步拉过来，未到位前显示一个简短占位串。
  const previewText = isEmpty
    ? (defaultPath ? `系统默认: ${defaultPath}` : "系统默认下载文件夹")
    : value;
  // 当系统默认还没拉到，"打开"按钮也没意义；同样道理 value 设了但是空字符
  // 串这种边缘 case 也不让点。
  const canReveal = isEmpty ? !!defaultPath : !!value;
  return (
    <div className="flex items-center gap-2 w-[320px]">
      <div
        className={`flex-1 bg-surface-container-high rounded-lg px-3 py-2 text-[12px] font-label truncate border border-outline-variant/10 ${
          isEmpty ? "text-on-surface-variant/45" : "text-on-surface"
        }`}
        title={previewText}
      >
        {previewText}
      </div>
      <button
        onClick={onReveal}
        disabled={!canReveal}
        className="w-9 h-9 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant/60 hover:text-on-surface flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title="在系统文件管理器中打开"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>folder_open</span>
      </button>
      {!isEmpty && (
        <button
          onClick={onClear}
          className="w-9 h-9 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant/60 hover:text-on-surface flex items-center justify-center transition-colors"
          title="清空 · 改回系统默认下载文件夹"
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
  commitOnBlur = true,
  trailing,
}: {
  value: string;
  placeholder?: string;
  type?: "text" | "password";
  onChange: (v: string) => void;
  /** Called when input loses focus (if commitOnBlur) or Enter is pressed. */
  onCommit?: () => void;
  /**
   * 默认 blur 也会触发 commit —— 适合普通字段的"自动保存"语义。
   * 但敏感字段（如 QQ 授权码这种 16 字符一气呵成的整串）blur 提交容易把
   * 半成品落库覆盖旧值。这类字段传 false，让用户只能用 Enter 显式提交。
   */
  commitOnBlur?: boolean;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <div className="bg-surface-container-high text-on-surface text-[12px] font-label rounded-lg pl-3 pr-2 border border-outline-variant/10 hover:border-outline-variant/25 focus-within:border-primary-container/40 transition-colors w-[280px] flex items-center gap-2">
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={commitOnBlur ? onCommit : undefined}
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
  const [webdavPath, setWebdavPath] = useState("MapleTools");
  const [webdavShowPwd, setWebdavShowPwd] = useState(false);
  const [webdavTestState, setWebdavTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [webdavTestMsg, setWebdavTestMsg] = useState("");
  const lastSavedWebdav = useRef({ account: "", password: "", path: "MapleTools" });

  useEffect(() => {
    window.webdavApi
      .getConfig()
      .then((cfg) => {
        if (!cfg) return;
        setWebdavAccount(cfg.account);
        setWebdavPassword(cfg.appPassword);
        // 老配置里 remotePath 可能是完整文件路径（"MapleTools/homework.json"），
        // 主进程在 loadConfig 时已经自动剥成 base folder（"MapleTools"），这里
        // 直接用就行；空 fallback 也用 base folder 默认。
        const p = cfg.remotePath || "MapleTools";
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

  // 系统默认下载文件夹 —— 留空 Settings.downloadPath 时主进程下载器会回退
  // 到这个路径。从 main 那边异步拉一次就够，进程生命周期内不变。
  const [defaultDownloadsPath, setDefaultDownloadsPath] = useState("");
  useEffect(() => {
    window.systemApi.getDefaultDownloadsPath()
      .then(setDefaultDownloadsPath)
      .catch(() => { /* 拿不到时 UI 退化为不显示具体路径，按钮 disabled */ });
  }, []);

  // 邮件提醒 —— 周历每次 14d TTL 过期触发自动发件。
  // authCode 永远不从主进程回传明文，UI 拿到的是 hasAuthCode 布尔。用户
  // 不重新输入授权码就提交 = 保留旧的加密值（mailApi.setConfig 把空串当
  // "沿用旧值"处理）。
  const [mailEnabled, setMailEnabled] = useState(false);
  const [mailQqEmail, setMailQqEmail] = useState("");
  const [mailAuthCode, setMailAuthCode] = useState("");
  const [mailHasAuthCode, setMailHasAuthCode] = useState(false);
  const [mailTestState, setMailTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [mailTestMsg, setMailTestMsg] = useState("");
  const lastSavedMail = useRef({ enabled: false, qqEmail: "", authCodeWasSet: false });

  useEffect(() => {
    window.mailApi
      .getConfig()
      .then(cfg => {
        setMailEnabled(cfg.enabled);
        setMailQqEmail(cfg.qqEmail);
        setMailHasAuthCode(cfg.hasAuthCode);
        lastSavedMail.current = { enabled: cfg.enabled, qqEmail: cfg.qqEmail, authCodeWasSet: cfg.hasAuthCode };
      })
      .catch(() => { /* 没配置过就保持默认空状态 */ });
  }, []);

  /**
   * 提交邮件配置。authCode 留空 = 沿用旧值（主进程逻辑保证），所以编辑邮箱/
   * 开关时不要求用户重新输入授权码。
   * 立即更新 lastSavedMail.authCodeWasSet 让 UI 在用户敲完授权码后正确显示
   * "已保存"占位符。
   */
  const persistMail = (override?: { enabled?: boolean }): Promise<void> => {
    const enabled = override?.enabled ?? mailEnabled;
    const cur = {
      enabled,
      qqEmail: mailQqEmail.trim(),
      authCode: mailAuthCode,
    };
    const last = lastSavedMail.current;
    if (
      cur.enabled === last.enabled &&
      cur.qqEmail === last.qqEmail &&
      !cur.authCode
    ) {
      return Promise.resolve();
    }
    return window.mailApi
      .setConfig(cur)
      .then(() => {
        lastSavedMail.current = {
          enabled: cur.enabled,
          qqEmail: cur.qqEmail,
          authCodeWasSet: cur.authCode ? true : last.authCodeWasSet,
        };
        if (cur.authCode) {
          // 写入成功后清掉输入框 + 让 hasAuthCode 显示"已保存"占位符
          setMailAuthCode("");
          setMailHasAuthCode(true);
        }
      })
      .catch(() => { /* 失败保持现状，用户自然会发现没生效 */ });
  };

  const handleMailToggle = (next: boolean): void => {
    setMailEnabled(next);
    void persistMail({ enabled: next });
  };

  const handleMailTest = async (): Promise<void> => {
    setMailTestState("testing");
    setMailTestMsg("");
    try {
      // 先保存当前 UI state，再发测试 —— 用户多半是输完才点测试，不能
      // 让测试还用旧 authCode。
      await persistMail();
      await window.mailApi.testSend();
      setMailTestState("ok");
      setMailTestMsg("已发送，请到 QQ 邮箱查收");
    } catch (e: unknown) {
      setMailTestState("error");
      setMailTestMsg(
        e instanceof Error
          ? e.message.replace(/^Error invoking remote method '[^']+': /, "")
          : "发送失败",
      );
    }
    setTimeout(() => { setMailTestState("idle"); setMailTestMsg(""); }, 6000);
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
                  hint={`每集存到 <保存路径>/[源] <番剧标题>/<集>.mp4，例：${(settings.downloadPath || defaultDownloadsPath || "<保存路径>")}/[Xifan] 鬼灭之刃/鬼灭之刃 - 01.mp4`}
                >
                  <Row
                    icon="folder_open"
                    title="默认下载目录"
                    desc="影响所有源（Xifan / Girigiri / Aowu）的默认保存位置。留空则用系统默认下载文件夹。"
                    density={tweaks.density}
                    control={
                      <PathControl
                        value={settings.downloadPath}
                        defaultPath={defaultDownloadsPath}
                        onPick={handlePickDownloadFolder}
                        onClear={() => updateSettings({ downloadPath: "" })}
                        onReveal={() => {
                          const effective = settings.downloadPath || defaultDownloadsPath;
                          if (effective) window.fileExplorerApi.open(effective);
                        }}
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
                    title="远程文件夹"
                    desc="相对于 WebDAV 根目录的基础文件夹，会在下面分别存放 homework.json 与 anime.json（追番数据），不存在时自动创建。"
                    density={tweaks.density}
                    control={
                      <TextControl
                        value={webdavPath}
                        placeholder="MapleTools"
                        onChange={setWebdavPath}
                        onCommit={persistWebdav}
                      />
                    }
                  />
                </Block>
              )}

              {active === "notify" && (
                <Block
                  title="番剧周历邮件提醒"
                  hint="只在 14 天缓存到期、点开 Calendar 自动拉到新数据时发送，手点刷新不会触发。"
                  footer={
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleMailTest}
                        disabled={mailTestState === "testing" || !mailQqEmail.trim() || (!mailHasAuthCode && !mailAuthCode)}
                        className={
                          // tonal fill：rest 已有底色 + 描边，对比明显；hover 加深一档。
                          // 跟项目里 ConfirmDeleteModal / WatchHere 等"明确动作按钮"统一风格。
                          mailTestState === "ok"
                            ? "inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-tertiary/20 text-tertiary border border-tertiary/40 hover:bg-tertiary/30 hover:border-tertiary/55 disabled:opacity-50 disabled:cursor-not-allowed text-[12px] font-label font-bold uppercase tracking-wider transition-colors"
                            : mailTestState === "error"
                              ? "inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-error/20 text-error border border-error/40 hover:bg-error/30 hover:border-error/55 disabled:opacity-50 disabled:cursor-not-allowed text-[12px] font-label font-bold uppercase tracking-wider transition-colors"
                              : "inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/20 text-primary border border-primary/40 hover:bg-primary/30 hover:border-primary/55 disabled:opacity-50 disabled:cursor-not-allowed text-[12px] font-label font-bold uppercase tracking-wider transition-colors"
                        }
                      >
                        <span
                          className={`material-symbols-outlined leading-none ${mailTestState === "testing" ? "animate-spin" : ""}`}
                          style={{ fontSize: 16 }}
                        >
                          {mailTestState === "ok" ? "check_circle" : mailTestState === "error" ? "error" : "send"}
                        </span>
                        {mailTestState === "testing" ? "发送中…" : mailTestState === "ok" ? "已发送" : "发送测试邮件"}
                      </button>
                      {mailTestMsg && (
                        <span className={`font-label text-[11px] ${mailTestState === "ok" ? "text-tertiary" : "text-error"}`}>
                          {mailTestMsg}
                        </span>
                      )}
                    </div>
                  }
                >
                  <Row
                    icon="notifications_active"
                    title="启用自动邮件"
                    desc="开启后，番剧周历每次 14 天缓存到期、点开 Calendar 拉到新数据时，会把整张周历表自动截图发到下面填的 QQ 邮箱。"
                    density={tweaks.density}
                    control={
                      <Switch checked={mailEnabled} onChange={handleMailToggle} />
                    }
                  />
                  <Row
                    icon="mail"
                    title="QQ 邮箱"
                    desc="同时作为发件人和收件人（自己发给自己）。"
                    density={tweaks.density}
                    control={
                      <TextControl
                        value={mailQqEmail}
                        placeholder="example@qq.com"
                        onChange={setMailQqEmail}
                        onCommit={() => void persistMail()}
                      />
                    }
                  />
                  <Row
                    icon="key"
                    title="授权码"
                    desc="QQ 邮箱后台「设置 → 账号 → 安全设置 → POP3/IMAP/SMTP 服务」开启后生成的授权码，不是登录密码。输入完按 Enter 提交，本地加密存储。"
                    density={tweaks.density}
                    control={
                      <TextControl
                        value={mailAuthCode}
                        placeholder={mailHasAuthCode ? "已保存（重新输入按 Enter 覆盖）" : "16 位授权码，输入完按 Enter"}
                        onChange={setMailAuthCode}
                        onCommit={() => void persistMail()}
                        commitOnBlur={false}
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
