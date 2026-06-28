import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthStore } from "@/store/auth";

export function RequireAuth() {
  const token = useAuthStore((s) => s.token);
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Outlet />;
}

export function RequireSuperuser() {
  const user = useAuthStore((s) => s.user);
  if (!user?.is_superuser) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-gray-500">
        <span className="text-4xl">🔒</span>
        <p className="text-sm font-medium">Superuser access required</p>
      </div>
    );
  }
  return <Outlet />;
}
