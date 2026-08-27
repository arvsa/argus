import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Globe2,
  LayoutDashboard,
  ListTree,
  LogOut,
  Menu,
  Network,
  Shield,
  User,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth";
import { useAppConfig } from "@/hooks/useAppConfig";
import { LiveFeedProvider } from "@/hooks/useLiveFeed";
import { WsIndicator } from "@/components/WsIndicator";

interface NavItem {
  to: string;
  label: string;
  icon: React.ElementType;
}

// Dashboard/Devices ride on the ping pipeline (/stats, /state, /ws/pings),
// which only exists on a client (zone-local) backend -- a central
// argus-server unmounts those routes, so its nav leads with Zones.
const clientNav: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/hierarchy", label: "Hierarchy", icon: Network },
  { to: "/devices", label: "Devices", icon: Activity },
  { to: "/zones", label: "Zones", icon: Globe2 },
];

const serverNav: NavItem[] = [
  { to: "/zones", label: "Zones", icon: Globe2 },
  { to: "/hierarchy", label: "Hierarchy", icon: Network },
];

const adminNav: NavItem[] = [
  { to: "/hierarchy/types", label: "Hierarchy Types", icon: ListTree },
  { to: "/admin/users", label: "Users", icon: Users },
];

export function AppShell() {
  const { user, logout } = useAuthStore();
  const { role, isLoaded } = useAppConfig();
  // Render no nav items until the role probe settles -- a moment of empty
  // sidebar beats flashing client-only links on a server deployment.
  const nav = isLoaded ? (role === "server" ? serverNav : clientNav) : [];
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  function handleLogout() {
    logout();
    navigate("/login");
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
      isActive ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
      collapsed && "justify-center"
    );

  const SidebarContent = () => (
    <div className="flex h-full flex-col">
      <div className={cn("flex items-center gap-2.5 px-4 py-4 border-b border-gray-100", collapsed && "justify-center")}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600">
          <Shield className="h-4 w-4 text-white" />
        </div>
        {!collapsed && <span className="font-bold text-gray-900">Argus</span>}
      </div>

      <nav className="flex-1 space-y-0.5 p-2 pt-3 overflow-y-auto">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            onClick={() => setMobileOpen(false)}
            className={navLinkClass}
            title={collapsed ? item.label : undefined}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}

        {user?.is_superuser && (
          <>
            <div className={cn("px-3 pt-4 pb-1", collapsed && "hidden")}>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Admin</p>
            </div>
            {adminNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                className={navLinkClass}
                title={collapsed ? item.label : undefined}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      <div className="border-t border-gray-100 p-2 space-y-0.5">
        <NavLink to="/profile" onClick={() => setMobileOpen(false)} className={navLinkClass} title={collapsed ? "Profile" : undefined}>
          <User className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Profile</span>}
        </NavLink>
        <button
          onClick={handleLogout}
          className={cn(
            "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-red-50 hover:text-red-700 transition-colors",
            collapsed && "justify-center"
          )}
          title={collapsed ? "Logout" : undefined}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Logout</span>}
        </button>
      </div>
    </div>
  );

  const shell = (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <aside
        className={cn(
          "relative hidden md:flex flex-col border-r border-gray-200 bg-white transition-all duration-200 shrink-0",
          collapsed ? "w-16" : "w-56"
        )}
      >
        <SidebarContent />
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="absolute left-0 top-1/2 z-10 -translate-y-1/2 hidden md:flex items-center justify-center h-6 w-6 rounded-full border border-gray-200 bg-white shadow-sm text-gray-400 hover:text-gray-600"
          style={{ left: collapsed ? 52 : 212 }}
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
        </button>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">
            <SidebarContent />
          </aside>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 gap-4">
          <button className="md:hidden rounded-lg p-1.5 text-gray-500 hover:bg-gray-100" onClick={() => setMobileOpen(true)}>
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>

          <div className="ml-auto flex items-center gap-4">
            {isLoaded && role === "client" && <WsIndicator />}
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">
                {user?.full_name?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase() ?? "?"}
              </div>
              <span className="hidden sm:block text-sm font-medium text-gray-700 max-w-[140px] truncate">
                {user?.full_name ?? user?.email}
              </span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );

  // The live feed's WebSocket (/ws/pings) only exists on a client backend;
  // mounting it on a server would show a permanent connection error. Wait
  // for the probe to settle -- role defaults to "client" while loading, and
  // mounting on that guess opens a doomed socket on server deployments.
  return isLoaded && role === "client" ? (
    <LiveFeedProvider>{shell}</LiveFeedProvider>
  ) : (
    shell
  );
}
