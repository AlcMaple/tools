import { NavLink } from "react-router-dom";

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
    <aside className="h-screen w-64 fixed left-0 top-0 bg-[#0e0e0e] flex flex-col py-8 z-50">
      {/* Brand */}
      <div className="px-6 mb-12">
        <h1 className="text-xl font-black text-[#ffb3b8] tracking-tighter">
          MAPLE TOOLS
        </h1>
        <p className="font-label text-[10px] text-[#e2e2e2]/40 tracking-widest mt-1">
          V1.0.0
        </p>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) =>
              `flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-all duration-150 group ${
                isActive
                  ? "text-[#ffb3b8] font-bold border-r-2 border-[#ffb3b8] bg-[#1f1f1f]"
                  : "text-[#e2e2e2]/60 hover:text-[#e2e2e2] hover:bg-[#1f1f1f]"
              }`
            }
          >
            <span className="material-symbols-outlined text-xl leading-none">
              {item.icon}
            </span>
            <span className="text-sm font-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* User */}
      {/* <div className="px-6 mt-auto">
        <div className="flex items-center space-x-3 p-3 rounded-xl bg-surface-container-high/40">
          <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center overflow-hidden flex-shrink-0">
            <span className="material-symbols-outlined text-on-primary text-sm">person</span>
          </div>
          <div className="overflow-hidden">
            <p className="text-xs font-bold truncate">Archivist_User</p>
            <p className="text-[10px] text-on-surface-variant/60 font-label">PRO PLAN</p>
          </div>
        </div>
      </div> */}
    </aside>
  );
}

export default Sidebar;
