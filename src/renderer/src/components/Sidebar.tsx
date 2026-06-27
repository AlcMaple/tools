import { NavLink } from "react-router-dom";
import { navGuard } from "../utils/navGuard";
import { probeToPaint } from "../utils/probe";
import { uiStore, useDrawerOpen } from "../stores/uiStore";

interface NavItem {
  label: string;
  path: string;
  icon: string;
}

const navItems: NavItem[] = [
  { label: "本地播放器", path: "/", icon: "subscriptions" },
  { label: "搜索下载", path: "/search", icon: "search" },
  { label: "下载队列", path: "/queue", icon: "download_for_offline" },
  { label: "动漫查询", path: "/anime-info", icon: "travel_explore" },
  { label: "我的追番", path: "/my-anime", icon: "grade" },
  { label: "番剧周历表", path: "/calendar", icon: "calendar_month" },
  { label: "资源管理器", path: "/file-explorer", icon: "folder_managed" },
  { label: "锦囊妙计", path: "/homework", icon: "swords" },
  { label: "妙语库", path: "/miaoyu", icon: "forum" },
];

/**
 * 导航列表。两套形态共用同一份 navItems：
 * - `mobile`：抽屉里始终显示文字标签，点选后顺手收起抽屉。
 * - 桌面/平板：图标常驻，文字只在 `lg` 出现（平板是 64px 图标轨）。
 */
function NavList({ mobile = false }: { mobile?: boolean }): JSX.Element {
  return (
    <nav className="flex-1 space-y-1">
      {navItems.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.path === "/"}
          onClick={(e) => {
            if (navGuard.isActive()) {
              e.preventDefault();
              navGuard.requestNavigation(item.path);
              return;
            }
            // 量"点击 → 切到的新页面绘制出来"的耗时,写进 main.log。
            probeToPaint(`nav:${item.path}`);
            if (mobile) uiStore.closeDrawer();
          }}
          className={({ isActive }) =>
            `flex items-center py-3 transition-colors duration-200 border-r-2 ${
              mobile
                ? "px-6 space-x-3"
                : "justify-center lg:justify-start px-0 lg:px-6 lg:space-x-3"
            } ${
              isActive
                ? "text-primary font-medium border-primary bg-surface-container"
                : "text-on-surface/60 font-medium border-transparent hover:text-on-surface hover:bg-surface-container"
            }`
          }
        >
          <span className="material-symbols-outlined text-lg leading-none">
            {item.icon}
          </span>
          <span className={`${mobile ? "" : "hidden lg:block"} font-label text-sm`}>
            {item.label}
          </span>
        </NavLink>
      ))}
    </nav>
  );
}

/** 顶部品牌块。桌面显示全称+版本；平板图标轨只留一个「M」。 */
function Brand({ compact = false }: { compact?: boolean }): JSX.Element {
  if (compact) {
    return (
      <div className="px-0 mb-12 flex justify-center lg:hidden">
        <h1 className="text-xl font-black text-primary tracking-tighter">M</h1>
      </div>
    );
  }
  return (
    <div className="px-6 mb-12">
      <h1 className="text-xl font-black text-primary tracking-tighter">
        MAPLE TOOLS
      </h1>
      <p className="font-label text-[10px] text-on-surface/40 tracking-widest mt-1">
        V{__APP_VERSION__}
      </p>
    </div>
  );
}

function Sidebar(): JSX.Element {
  const drawerOpen = useDrawerOpen();

  return (
    <>
      {/* 平板/桌面常驻侧栏：平板 64px 图标轨（md），桌面 256px 全栏（lg）。
         手机档（<md）整体隐藏，改用下面的抽屉。 */}
      <aside className="hidden md:flex h-screen md:w-16 lg:w-64 fixed left-0 top-0 bg-surface-container-lowest flex-col py-8 z-50 transition-[width] duration-200">
        {/* 平板轨只显示「M」，桌面全栏显示全称 —— 用两个 Brand 靠断点切换 */}
        <Brand compact />
        <div className="hidden lg:block">
          <Brand />
        </div>
        <NavList />
      </aside>

      {/* 手机档遮罩：点击关闭抽屉 */}
      <div
        className={`md:hidden fixed inset-0 bg-black/50 z-[60] transition-opacity duration-300 ${
          drawerOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => uiStore.closeDrawer()}
      />

      {/* 手机档抽屉：从左侧滑入，盖在内容上（不挤压正文，所以正文 ml-0）。 */}
      <aside
        className={`md:hidden fixed left-0 top-0 bottom-0 w-60 bg-surface-container-lowest flex flex-col py-8 z-[70] transition-transform duration-300 ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Brand />
        <NavList mobile />
      </aside>
    </>
  );
}

export default Sidebar;
