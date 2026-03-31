import { NavLink } from "react-router-dom";
import { navGuard } from "../utils/navGuard";

interface NavItem {
  label: string;
  path: string;
  icon: string;
}

const navItems: NavItem[] = [
  { label: "Search & Download", path: "/", icon: "search" },
  { label: "Download Queue", path: "/queue", icon: "download_for_offline" },
  { label: "Anime Info", path: "/anime-info", icon: "menu_book" },
  { label: "Biu Sync", path: "/biu-sync", icon: "sync" },
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
          V1.0.0
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
              }
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
