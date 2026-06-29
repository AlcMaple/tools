import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useSystemStats } from "../hooks/useSystemStats";
import { updateStore, type UpdateState } from "../stores/updateStore";
import { reportError } from "../utils/reportError";
import type { BgmAuthStatus } from "../types/bgm";
import { setCachedAuth } from "../utils/bgmAuth";

// ── persistence keys ─────────────────────────────────────────
const NODE_ID_KEY = "xifan_node_id";
const SETTINGS_KEY = "xifan_settings";
const ACTIVE_CATEGORY_KEY = "maple-settings-category";
const TWEAKS_KEY = "maple-settings-tweaks";

interface SavedSettings {
  downloadPath?: string;
  searchCacheEnabled?: boolean;
  minimizeOnClose?: boolean;
  /** 是否启用启动时的自动检查更新（默认 true）。关掉之后不会自动弹更新
   *  卡片，但用户仍能在「关于 → 检查更新」按钮手动触发。 */
  autoUpdateCheckEnabled?: boolean;
  /** 更新源：'auto' = 优先国内加速（ghproxy 代理链）、失败回退 GitHub（默认，
   *  无魔法用户用这个）；'github' = 强制直连 GitHub（有魔法用户跳过代理）。 */
  updateSource?: "auto" | "github";
}

const DEFAULTS: Required<SavedSettings> = {
  downloadPath: "",
  searchCacheEnabled: true,
  // 默认关闭 —— 跟 OS 惯例对齐（X = 真的退出，不是偷偷常驻）。
  // 想要"关掉窗口仍在后台下载 / 发邮件"的用户自己进设置打开即可，
  // 一个开关零摩擦。
  minimizeOnClose: false,
  autoUpdateCheckEnabled: true,
  updateSource: "auto",
};

// Settings-page-specific UI tweaks — meta-controls in the floating Tweaks panel.
// 导航样式（侧栏/标签）不再让用户选 —— 改为纯响应式：宽窗用侧栏、窄窗(<lg)自动换标签条。
type Density = "compact" | "comfortable" | "spacious";

interface Tweaks {
  density: Density;
}

const TWEAKS_DEFAULT: Tweaks = {
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
      autoUpdateCheckEnabled: s.autoUpdateCheckEnabled ?? DEFAULTS.autoUpdateCheckEnabled,
      updateSource: s.updateSource === "github" ? "github" : DEFAULTS.updateSource,
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
        autoUpdateCheckEnabled: s.autoUpdateCheckEnabled,
        updateSource: s.updateSource,
      }),
    );
  } catch { /* ignore */ }
}

function readTweaks(): Tweaks {
  try {
    const raw = JSON.parse(localStorage.getItem(TWEAKS_KEY) || "{}") as Partial<Tweaks>;
    return {
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
  stack = false,
}: {
  icon: string;
  title: string;
  desc: string;
  density: Density;
  control: ReactNode;
  /**
   * 较宽控件（路径选择 / 文本输入 / 分段选择）传 `stack`：窄屏（<sm）把控件挪到
   * 描述下方、靠右下角；描述则占满整行、正常折行（否则被控件挤成一字一行很丑）。
   * 输入框这类是整宽铺开，分段/按钮则保持本身宽度靠右。开关 / 只读值这类窄控件不传，
   * 始终「文本左 / 控件右」—— 它们再窄也放得下，堆叠反而割裂、浪费竖向空间。
   */
  stack?: boolean;
}): JSX.Element {
  const heightCls =
    density === "compact" ? "py-3.5" : density === "spacious" ? "py-7" : "py-5";
  return (
    <div className={`group flex items-start gap-4 sm:gap-5 px-4 sm:px-6 ${heightCls} hover:bg-on-surface/[0.02] transition-colors`}>
      <div className="mt-0.5 w-9 h-9 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant flex-shrink-0">
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 20 }}>{icon}</span>
      </div>
      <div className={`flex-1 min-w-0 flex gap-3 sm:gap-5 ${stack ? "flex-col sm:flex-row sm:items-start" : "items-center"}`}>
        <div className="flex-1 min-w-0 pr-2 sm:pr-4">
          <h3 className="font-headline font-semibold text-[14px] text-on-surface tracking-tight">{title}</h3>
          <p className="font-body text-[12px] leading-relaxed text-on-surface-variant/60 mt-1 max-w-2xl">{desc}</p>
        </div>
        <div
          className={`flex-shrink-0 flex justify-end sm:min-w-[180px] ${
            stack ? "w-full sm:w-auto self-stretch sm:self-center" : "self-center"
          }`}
        >
          {control}
        </div>
      </div>
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
      <header className="px-4 sm:px-6 pt-5 pb-3 flex items-baseline justify-between gap-4">
        <h2 className="font-headline font-bold text-[12px] uppercase tracking-[0.2em] text-on-surface-variant/60">{title}</h2>
        {hint && <span className="font-body text-[11px] text-on-surface-variant/35 max-w-md text-right hidden md:block">{hint}</span>}
      </header>
      <div className="divide-y divide-outline-variant/10">{children}</div>
      {footer && <div className="px-4 sm:px-6 py-4 border-t border-outline-variant/10 bg-surface-container-low/40">{footer}</div>}
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
    <div className="flex items-center gap-2 w-full sm:w-[320px]">
      <div
        className={`flex-1 min-w-0 bg-surface-container-high rounded-lg px-3 py-2 text-[12px] font-label truncate border border-outline-variant/10 ${
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
    <div className="bg-surface-container-high text-on-surface text-[12px] font-label rounded-lg pl-3 pr-2 border border-outline-variant/10 hover:border-outline-variant/25 focus-within:border-primary-container/40 transition-colors w-full sm:w-[280px] flex items-center gap-2">
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={commitOnBlur ? onCommit : undefined}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && onCommit) onCommit(); }}
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

/**
 * 设置页「检查更新」按钮 + 状态指示。
 *
 * 不直接拿 updateStore 的 status 当唯一来源 —— banner 已经在显示 downloaded
 * / available-mac 时，按钮文案仍然给一个明确的反馈（"v0.3.0 已下载"），便于
 * 用户从设置页确认状态而不需要回到其他页面看 banner。
 *
 * 按钮 disabled 仅在 `checking` 阶段，防止重复触发。其他状态都允许再次点击
 * （比如发生 error 后用户想重试）。
 */
function UpdateCheckControl(): JSX.Element {
  const [state, setState] = useState<UpdateState>(updateStore.getState());

  useEffect(() => {
    return updateStore.subscribe(() => setState(updateStore.getState()));
  }, []);

  let label = "检查更新";
  let hint = "";
  let icon = "refresh";

  switch (state.status) {
    case "checking":
      label = "检查中…";
      icon = "progress_activity";
      break;
    case "available":
      label = `v${state.newVersion} 下载中`;
      hint = state.progressPercent != null ? ` ${state.progressPercent}%` : "";
      icon = "downloading";
      break;
    case "downloaded":
      label = `v${state.newVersion} 已下载`;
      hint = "点击重启安装";
      icon = "system_update";
      break;
    case "available-mac":
      label = `v${state.newVersion} 可用`;
      hint = "点击前往下载页";
      icon = "system_update";
      break;
    case "not-available":
      label = "已是最新版本";
      icon = "check_circle";
      break;
    case "error":
      label = "检查失败 · 重试";
      icon = "error";
      break;
  }

  const isBusy = state.status === "checking" || state.status === "available";
  const isActionable = state.status === "downloaded" || state.status === "available-mac";

  const onClick = (): void => {
    if (isBusy) return;
    if (isActionable) {
      void updateStore.install();
    } else {
      void updateStore.check();
    }
  };

  return (
    <button
      onClick={onClick}
      disabled={isBusy}
      className={`px-3 py-1.5 rounded-lg flex items-center gap-2 font-label text-[12px] transition-colors ${
        isActionable
          ? "bg-tertiary-container text-on-tertiary-container hover:opacity-90"
          : "bg-surface-container-high hover:bg-surface-bright text-on-surface-variant hover:text-on-surface"
      } disabled:opacity-50 disabled:cursor-not-allowed`}
      title={hint || undefined}
    >
      <span
        className={`material-symbols-outlined leading-none ${state.status === "checking" ? "animate-spin" : ""}`}
        style={{ fontSize: 16 }}
      >
        {icon}
      </span>
      <span>{label}{hint && state.status === "available" ? hint : ""}</span>
    </button>
  );
}

// ── header (sticky) ──────────────────────────────────────────
function SettingsHeader({
  onBack,
  onOpenTweaks,
  onOpenNav,
}: {
  onBack: () => void;
  onOpenTweaks: () => void;
  /** 打开分类抽屉（仅窄窗 <lg 显示触发按钮，侧栏此时收起）。 */
  onOpenNav: () => void;
}): JSX.Element {
  const { diskFreeLabel, activeTasks, networkOnline, speedLabel } = useSystemStats();
  return (
    <header className="sticky top-0 z-40 bg-background/85 backdrop-blur-xl border-b border-outline-variant/10">
      <div className="h-14 px-4 md:px-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 md:gap-4 min-w-0">
          <button
            onClick={onBack}
            className="w-8 h-8 shrink-0 rounded-lg hover:bg-on-surface/[0.04] flex items-center justify-center text-on-surface-variant"
            title="返回"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 18 }}>arrow_back</span>
          </button>
          <div className="flex items-center gap-2 font-label text-[10px] uppercase tracking-[0.25em] text-on-surface-variant/60 min-w-0">
            <span className="text-on-surface/80">Dashboard</span>
            <span className="text-on-surface-variant/30">/</span>
            <span className="truncate">System Preferences</span>
          </div>
        </div>
        <div className="flex items-center gap-3 lg:gap-5 shrink-0">
          {/* 系统统计（容量/任务/速率/网络）—— 窄窗收起，对齐全局顶栏的做法，只留分类 + 界面调节入口。 */}
          <div className="hidden lg:flex items-center gap-5">
            <Stat icon="storage" label={diskFreeLabel} />
            <Stat icon="downloading" label={`${activeTasks} TASKS`} active={activeTasks > 0} />
            <Stat icon="speed" label={speedLabel} />
            <div className={`flex items-center gap-1.5 ${networkOnline ? "text-green-400" : "text-red-500"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${networkOnline ? "bg-green-400 animate-pulse" : "bg-red-500"}`} />
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>{networkOnline ? "wifi_tethering" : "wifi_off"}</span>
              <span className="font-label text-[10px] tracking-widest uppercase">{networkOnline ? "Online" : "Offline"}</span>
            </div>
            <span className="h-4 w-px bg-outline-variant/20" />
          </div>
          <button
            onClick={onOpenTweaks}
            className="w-8 h-8 rounded-lg hover:bg-on-surface/[0.04] flex items-center justify-center text-on-surface-variant"
            title="界面调节"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>tune</span>
          </button>
          {/* 分类抽屉触发 —— 仅窄窗显示，放在最右侧（抽屉就从右侧滑出），左上角返回键始终不被遮挡。 */}
          <button
            onClick={onOpenNav}
            className="lg:hidden w-8 h-8 rounded-lg hover:bg-on-surface/[0.04] flex items-center justify-center text-on-surface-variant"
            title="分类导航"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 20 }}>menu</span>
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

// ── category nav ─────────────────────────────────────────────
/** 6 个分类按钮（图标 + 中文 + 英文副标） —— 侧栏与抽屉复用同一份。 */
function CategoryList({
  active,
  onSelect,
}: {
  active: CategoryId;
  onSelect: (id: CategoryId) => void;
}): JSX.Element {
  return (
    <>
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
    </>
  );
}

/**
 * 宽屏（≥lg）的常驻分类侧栏（260px）。窄屏侧栏整体收起，改用从右侧滑出的抽屉
 * （见 CategoryDrawer）—— PC 上不做横向滑动、也不让侧栏挤占内容。
 */
function CategoryRail({
  active,
  onSelect,
}: {
  active: CategoryId;
  onSelect: (id: CategoryId) => void;
}): JSX.Element {
  return (
    <aside className="hidden lg:flex w-64 flex-shrink-0 border-r border-outline-variant/10 bg-surface-container-low/30 flex-col">
      <div className="px-6 pt-8 pb-5">
        <div className="font-label text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/40 mb-2">Settings</div>
        <h1 className="font-headline font-black text-[28px] tracking-tight text-on-surface leading-none">
          系统偏好<span className="text-primary-container">.</span>
        </h1>
      </div>
      <nav className="px-3 flex-1 overflow-y-auto custom-scrollbar pb-6">
        <CategoryList active={active} onSelect={onSelect} />
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

/**
 * 窄屏（<lg）的分类抽屉 —— 从**右侧**滑出（左上角返回键不被遮挡），由顶栏右上的
 * ☰ 触发，跟「界面调节」并排同样从右侧出。点遮罩 / 选分类 / Esc 关闭。
 */
function CategoryDrawer({
  open,
  active,
  onSelect,
  onClose,
}: {
  open: boolean;
  active: CategoryId;
  onSelect: (id: CategoryId) => void;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <div className="lg:hidden">
      {/* 遮罩 —— 抽屉宽 w-64，左侧露出的部分即遮罩，点它关闭；返回键在左上仍可见 */}
      <div
        className={`fixed inset-0 bg-black/50 z-[60] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />
      <aside
        className={`fixed right-0 top-0 bottom-0 w-64 max-w-[80vw] z-[70] bg-surface-container-low border-l border-outline-variant/10 flex flex-col transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="h-14 px-5 flex items-center justify-between border-b border-outline-variant/10">
          <span className="font-label text-[11px] uppercase tracking-[0.25em] text-on-surface-variant">Categories</span>
          <button
            onClick={onClose}
            className="w-8 h-8 -mr-2 rounded-lg hover:bg-on-surface/[0.04] flex items-center justify-center text-on-surface-variant/60 hover:text-on-surface"
            title="关闭"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
        <nav className="px-3 py-4 flex-1 overflow-y-auto custom-scrollbar">
          <CategoryList active={active} onSelect={(id) => { onSelect(id); onClose(); }} />
        </nav>
      </aside>
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
      <div className="fixed top-16 right-4 md:right-6 z-50 w-[300px] max-w-[calc(100vw-2rem)] bg-surface-container-high/95 backdrop-blur-xl border border-outline-variant/15 rounded-2xl shadow-2xl">
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
    // autoUpdateCheckEnabled 是主进程行为开关（决定启动时要不要跑 updater
    // 自动检查），必须同步到 app_settings.json，否则下次重启 dev/应用时
    // 主进程读到的还是默认 true，自动检查照跑不误。
    if (patch.autoUpdateCheckEnabled !== undefined) {
      window.systemApi.setSetting?.("autoUpdateCheckEnabled", patch.autoUpdateCheckEnabled).catch(() => {});
    }
    // updateSource 同理是主进程行为开关（updater 据此决定走代理链还是直连
    // GitHub），必须同步到 app_settings.json。
    if (patch.updateSource !== undefined) {
      window.systemApi.setSetting?.("updateSource", patch.updateSource).catch(() => {});
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
    }).catch((err) => reportError("settings:webdav-save", err));
  };

  // 系统默认下载文件夹 —— 留空 Settings.downloadPath 时主进程下载器会回退
  // 到这个路径。从 main 那边异步拉一次就够，进程生命周期内不变。
  const [defaultDownloadsPath, setDefaultDownloadsPath] = useState("");
  useEffect(() => {
    window.systemApi.getDefaultDownloadsPath()
      .then(setDefaultDownloadsPath)
      .catch(() => { /* 拿不到时 UI 退化为不显示具体路径，按钮 disabled */ });
  }, []);

  // 是否 dev(非打包)运行 —— 决定「关于」里要不要显示「打开开发者工具」按钮。
  const [isDev, setIsDev] = useState(false);
  useEffect(() => {
    window.systemApi.isDev()
      .then(setIsDev)
      .catch(() => { /* 拿不到当打包处理，不显示按钮 */ });
  }, []);

  // BGM 鉴权（令牌 + 网页登录）。token / cookie 明文不出主进程，UI 只拿状态布尔。
  const [bgmAuth, setBgmAuth] = useState<BgmAuthStatus>({ hasToken: false, loggedIn: false });
  const [bgmTokenInput, setBgmTokenInput] = useState("");
  const [bgmShowToken, setBgmShowToken] = useState(false);
  const [bgmLoggingIn, setBgmLoggingIn] = useState(false);
  const [bgmVerifying, setBgmVerifying] = useState(false);
  // 设置里**只取状态、不自动校验**（用户要求）——是否过期由用户点「检查」手动确认。
  // 注意:动漫查询页的 chip 会按 8 点边界自动校验,过期时主进程会清 cookie,所以这里
  // authStatus 读到的「已登录」通常已是真实的(被 chip 校验维护过)。
  useEffect(() => {
    window.bgmApi.authStatus().then(setBgmAuth).catch(() => { /* 拿不到当未配置 */ });
  }, []);
  // 手动操作都回填共享缓存,让动漫查询页的 chip 立刻同步,不必等下个 8 点窗口。
  const applyBgm = (s: BgmAuthStatus): void => { setBgmAuth(s); setCachedAuth(s); };
  const recheckBgm = async (): Promise<void> => {
    setBgmVerifying(true);
    try { applyBgm(await window.bgmApi.verifyLogin()); }
    finally { setBgmVerifying(false); }
  };
  const saveBgmToken = async (): Promise<void> => {
    const v = bgmTokenInput.trim();
    if (!v) return;
    applyBgm(await window.bgmApi.setToken(v));
    setBgmTokenInput("");
  };
  const clearBgmToken = async (): Promise<void> => {
    applyBgm(await window.bgmApi.setToken(""));
    setBgmTokenInput("");
  };
  const doBgmLogin = async (): Promise<void> => {
    setBgmLoggingIn(true);
    try { applyBgm(await window.bgmApi.login()); }
    finally { setBgmLoggingIn(false); }
  };
  const doBgmLogout = async (): Promise<void> => {
    applyBgm(await window.bgmApi.logout());
  };

  // BGM 登录邮箱/密码 —— 供内嵌登录窗自动填充。纯本地存储(不同步、不入库),
  // 和 WebDAV 应用密码同一处理,所以明文回显 + 小眼睛。
  const [bgmEmail, setBgmEmail] = useState("");
  const [bgmPassword, setBgmPassword] = useState("");
  const [bgmShowPwd, setBgmShowPwd] = useState(false);
  const lastSavedBgmCreds = useRef({ email: "", password: "" });
  useEffect(() => {
    window.bgmApi.getCredentials().then((c) => {
      setBgmEmail(c.email);
      setBgmPassword(c.password);
      lastSavedBgmCreds.current = { email: c.email, password: c.password };
    }).catch(() => { /* 没存过 = 空,正常 */ });
  }, []);
  const persistBgmCreds = (): void => {
    const cur = { email: bgmEmail.trim(), password: bgmPassword };
    const last = lastSavedBgmCreds.current;
    if (cur.email === last.email && cur.password === last.password) return; // 没变 → 不发 IPC
    window.bgmApi.setCredentials(cur.email, cur.password).then(() => {
      lastSavedBgmCreds.current = { email: cur.email, password: cur.password };
    }).catch((err) => reportError("settings:bgm-creds-save", err));
  };

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
      .catch((err) => reportError("settings:mail-save", err));
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
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
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
  return (
    <div className="h-full flex flex-col bg-background relative">
      <SettingsHeader
        onBack={() => navigate(-1)}
        onOpenTweaks={() => setTweaksOpen((o) => !o)}
        onOpenNav={() => setNavDrawerOpen(true)}
      />

      <div className="flex flex-1 min-h-0">
        {/* 宽屏（≥lg）常驻侧栏；窄屏侧栏收起，改用从右侧滑出的分类抽屉（见底部 CategoryDrawer）。 */}
        <CategoryRail active={active} onSelect={setActive} />

        <main className="flex-1 overflow-y-auto custom-scrollbar">

          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-10 pb-16">
            {/* Category header */}
            <div key={active} className="mb-6 lg:mb-8 animate-fade-in">
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

              {active === "general" && (
                <Block
                  title="BGM 账号"
                  hint="动漫查询的数据来自 Bangumi。匿名访问会被故意拖慢/限流；配置下面任一项可显著改善（两项作用不同，建议都配）。"
                >
                  <Row
                    icon="vpn_key"
                    title="访问令牌"
                    desc="给「番剧详情 / 按别名搜索」用（api.bgm.tv）。登录 BGM 后在 next.bgm.tv/demo/access-token 生成、粘贴到这里即可。"
                    density={tweaks.density}
                    stack
                    control={
                      <TextControl
                        value={bgmTokenInput}
                        placeholder={bgmAuth.hasToken ? "已配置令牌（粘贴可替换）" : "粘贴你的 BGM 访问令牌…"}
                        type={bgmShowToken ? "text" : "password"}
                        onChange={setBgmTokenInput}
                        onCommit={saveBgmToken}
                        trailing={
                          <span className="flex items-center flex-shrink-0">
                            <button
                              onClick={() => setBgmShowToken((v) => !v)}
                              className="text-on-surface-variant/40 hover:text-on-surface transition-colors px-1"
                              type="button"
                              title={bgmShowToken ? "隐藏" : "明文查看"}
                            >
                              <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>
                                {bgmShowToken ? "visibility_off" : "visibility"}
                              </span>
                            </button>
                            {bgmAuth.hasToken && (
                              <button
                                onClick={() => { void clearBgmToken(); }}
                                className="text-on-surface-variant/40 hover:text-error transition-colors px-1"
                                type="button"
                                title="清除已保存的令牌"
                              >
                                <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>delete</span>
                              </button>
                            )}
                          </span>
                        }
                      />
                    }
                  />
                  <Row
                    icon="login"
                    title="网页登录"
                    desc="给「主搜索」用（bgm.tv 网页）。点下面按钮弹出 BGM 登录页，登录成功后自动记住登录态，主搜索从约 16 秒提速到约 1 秒。登录态过期后再登一次即可。填了下面的邮箱/密码后，登录窗会自动填好，只剩验证码要手动输。"
                    density={tweaks.density}
                    control={
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        {/* 状态如实反映:打开设置已自动校验过(过期会回落成未登录) */}
                        <span
                          className={`inline-flex items-center gap-1 font-label text-[11px] ${bgmAuth.loggedIn ? "text-primary" : "text-on-surface-variant/50"}`}
                          title={bgmAuth.loggedIn ? "登录态有效" : "未登录或登录态已过期"}
                        >
                          <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>
                            {bgmVerifying ? "sync" : bgmAuth.loggedIn ? "check_circle" : "cancel"}
                          </span>
                          {bgmVerifying ? "检查中…" : bgmAuth.loggedIn ? "已登录" : "未登录"}
                        </span>
                        {bgmAuth.loggedIn ? (
                          /* 已登录:只给「检查 / 退出」。登录态有效时不出现登录按钮。 */
                          <>
                            <button
                              onClick={() => { void recheckBgm(); }}
                              disabled={bgmVerifying}
                              className="inline-flex items-center px-3 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant/70 hover:text-on-surface font-label text-[11px] uppercase tracking-widest transition-colors disabled:opacity-50"
                              type="button"
                              title="手动校验登录态是否过期"
                            >
                              检查
                            </button>
                            <button
                              onClick={() => { void doBgmLogout(); }}
                              className="inline-flex items-center px-3 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant/70 hover:text-on-surface font-label text-[11px] uppercase tracking-widest transition-colors"
                              type="button"
                            >
                              退出
                            </button>
                          </>
                        ) : (
                          /* 未登录 / 检查后发现过期:才出现登录按钮。 */
                          <button
                            onClick={() => { void doBgmLogin(); }}
                            disabled={bgmLoggingIn}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/90 hover:bg-primary text-on-primary font-label text-[11px] uppercase tracking-widest transition-colors disabled:opacity-50"
                            type="button"
                          >
                            <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>login</span>
                            {bgmLoggingIn ? "登录中…" : "登录 BGM"}
                          </button>
                        )}
                      </div>
                    }
                  />
                  <Row
                    icon="account_circle"
                    title="登录邮箱"
                    desc="点「登录 BGM」时自动填进登录页的邮箱框。纯本地保存，不上传、不同步，别人拉代码也拿不到。"
                    density={tweaks.density}
                    stack
                    control={
                      <TextControl
                        value={bgmEmail}
                        placeholder="登录 BGM 用的邮箱"
                        onChange={setBgmEmail}
                        onCommit={persistBgmCreds}
                      />
                    }
                  />
                  <Row
                    icon="password"
                    title="登录密码"
                    desc="同上，自动填进密码框。验证码 BGM 防自动化，仍需你手动输入。"
                    density={tweaks.density}
                    stack
                    control={
                      <TextControl
                        value={bgmPassword}
                        placeholder="••••••••"
                        type={bgmShowPwd ? "text" : "password"}
                        onChange={setBgmPassword}
                        onCommit={persistBgmCreds}
                        trailing={
                          <button
                            onClick={() => setBgmShowPwd((v) => !v)}
                            className="text-on-surface-variant/40 hover:text-on-surface transition-colors flex-shrink-0 px-1"
                            type="button"
                            title={bgmShowPwd ? "隐藏" : "明文查看"}
                          >
                            <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>
                              {bgmShowPwd ? "visibility_off" : "visibility"}
                            </span>
                          </button>
                        }
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
                    stack
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
                    stack
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
                    stack
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
                    stack
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
                    stack
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
                    stack
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
                    stack
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
                    icon="auto_mode"
                    title="自动检查更新"
                    desc="启用后，启动应用时会静默检查是否有新版本，发现新版本会弹窗提示。关闭后启动不再自动检查，但仍可通过下方「检查更新」按钮手动触发。"
                    density={tweaks.density}
                    control={
                      <Switch
                        checked={settings.autoUpdateCheckEnabled}
                        onChange={(v) => updateSettings({ autoUpdateCheckEnabled: v })}
                      />
                    }
                  />
                  <Row
                    icon="cloud_download"
                    title="更新源"
                    desc="「国内加速」优先走国内可达的镜像下载、失败自动回退 GitHub —— 无魔法也能更新，推荐默认。「直连 GitHub」强制走原始源，适合有代理 / 魔法的用户。"
                    density={tweaks.density}
                    stack
                    control={
                      <Segment
                        value={settings.updateSource}
                        onChange={(v) => updateSettings({ updateSource: v })}
                        options={[
                          { v: "auto", l: "国内加速" },
                          { v: "github", l: "直连 GitHub" },
                        ]}
                      />
                    }
                  />
                  <Row
                    icon="update"
                    title="检查更新"
                    desc="不受上面自动检查开关影响 —— 点这里永远会真的跑一次检查。Windows 下会在应用内静默下载并提示重启安装；macOS 因未做代码签名，发现新版本时会引导前往下载页手动安装。"
                    density={tweaks.density}
                    control={<UpdateCheckControl />}
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
                  <Row
                    icon="description"
                    title="运行日志"
                    desc="出问题时这里能找到详细报错记录（仅本地）。排查 bug、反馈问题时可以打开看看。"
                    density={tweaks.density}
                    control={
                      <button
                        onClick={() => { void window.systemApi.openLogDir() }}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant/70 hover:text-on-surface font-label text-[11px] uppercase tracking-widest transition-colors"
                        title="打开日志所在目录"
                      >
                        <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>folder_open</span>
                        打开日志目录
                      </button>
                    }
                  />
                  {/* 开发者工具 —— 仅 dev(npm run dev)显示;打包版不暴露。
                      等同 F12 / Ctrl+Shift+I,给记不住快捷键的人一个按钮。 */}
                  {isDev && (
                    <Row
                      icon="terminal"
                      title="开发者工具"
                      desc="打开 / 关闭 F12 那样的控制台,用来检查页面元素、看报错。仅开发模式可见,打包版不提供。"
                      density={tweaks.density}
                      control={
                        <button
                          onClick={() => { void window.systemApi.toggleDevTools() }}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant/70 hover:text-on-surface font-label text-[11px] uppercase tracking-widest transition-colors"
                          title="开关开发者工具(F12)"
                        >
                          <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>terminal</span>
                          打开控制台
                        </button>
                      }
                    />
                  )}
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

      {/* 窄窗分类抽屉（从右侧滑出） */}
      <CategoryDrawer
        open={navDrawerOpen}
        active={active}
        onSelect={setActive}
        onClose={() => setNavDrawerOpen(false)}
      />

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
