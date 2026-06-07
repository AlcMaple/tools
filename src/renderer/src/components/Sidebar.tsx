import { NavLink } from "react-router-dom";
import { navGuard } from "../utils/navGuard";
import { probeToPaint } from "../utils/probe";

interface NavItem {
  label: string;
  path: string;
  icon: string;
}

const navItems: NavItem[] = [
  { label: "本地播放器", path: "/", icon: "subscriptions" },
  { label: "搜索下载", path: "/search", icon: "search" },
  { label: "下载队列", path: "/queue", icon: "download_for_offline" },
  { label: "动漫查询", path: "/anime-info", icon: "menu_book" },
  { label: "我的追番", path: "/my-anime", icon: "bookmarks" },
  { label: "番剧周历表", path: "/calendar", icon: "calendar_month" },
  { label: "资源管理器", path: "/file-explorer", icon: "folder_managed" },
  { label: "作业查询", path: "/homework", icon: "swords" },
];

function Sidebar(): JSX.Element {
  return (
    <aside className="h-screen w-64 fixed left-0 top-0 bg-surface-container-lowest flex flex-col py-8 z-50">
      {/* Brand */}
      <div className="px-6 mb-12">
        <h1 className="text-xl font-black text-primary tracking-tighter">
          MAPLE TOOLS
        </h1>
        <p className="font-label text-[10px] text-on-surface/40 tracking-widest mt-1">
          V{__APP_VERSION__}
        </p>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            onClick={(e) => {
              if (navGuard.isActive()) {
                e.preventDefault()
                navGuard.requestNavigation(item.path)
                return
              }
              // 量"点击 → 切到的新页面绘制出来"的耗时,写进 main.log。
              probeToPaint(`nav:${item.path}`)
            }}
            className={({ isActive }) =>
              `flex items-center px-6 py-3 space-x-3 transition-colors duration-200 ${
                isActive
                  ? "text-primary font-bold border-r-2 border-primary bg-surface-container"
                  : "text-on-surface/60 font-medium hover:text-on-surface hover:bg-surface-container"
              }`
            }
          >
            <span className="material-symbols-outlined text-lg leading-none">
              {item.icon}
            </span>
            <span className="font-label text-sm">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

export default Sidebar;
