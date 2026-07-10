import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAppConfig } from "@/hooks/useAppConfig";
import { PageSpinner } from "@/components/Spinner";
import { Dashboard } from "@/pages/Dashboard";

// Landing page for "/": the live Dashboard only makes sense against a
// client (zone-local) backend -- a central argus-server has no ping
// pipeline, so its home is the zones overview. Waits for the role probe
// rather than flashing the wrong page.
export function RoleLanding() {
  const { role, isLoaded } = useAppConfig();
  if (!isLoaded) return <PageSpinner />;
  return role === "server" ? <Navigate to="/zones" replace /> : <Dashboard />;
}

// Wraps routes whose backend endpoints only exist on a client deployment
// (/state, /stats, /ws/pings); on a server they'd 404, so redirect home
// instead of rendering a page of error states.
export function ClientOnlyRoute({ children }: { children: ReactNode }) {
  const { role, isLoaded } = useAppConfig();
  if (!isLoaded) return <PageSpinner />;
  if (role === "server") return <Navigate to="/" replace />;
  return <>{children}</>;
}
