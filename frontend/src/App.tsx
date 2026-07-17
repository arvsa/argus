import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/layouts/AppShell";
import { AuthLayout } from "@/layouts/AuthLayout";
import { RequireAuth, RequireSuperuser } from "@/layouts/RequireAuth";
import { RoleLanding, ClientOnlyRoute } from "@/layouts/RoleGates";
import { Login } from "@/pages/Login";
import { Register } from "@/pages/Register";
import { ForgotPassword } from "@/pages/ForgotPassword";
import { ResetPassword } from "@/pages/ResetPassword";
import { Profile } from "@/pages/Profile";
import { NodeTypesPage } from "@/pages/hierarchy/NodeTypes";
import { NodesPage } from "@/pages/hierarchy/Nodes";
import { DevicesPage } from "@/pages/Devices";
import { ZonesPage } from "@/pages/Zones";
import { ZoneDetailPage } from "@/pages/ZoneDetail";
import { UsersPage } from "@/pages/admin/Users";
import { DiscoveredDevicesPage } from "@/pages/admin/DiscoveredDevices";
import { InfraTargetsPage } from "@/pages/admin/InfraTargets";
import { Toaster } from "@/components/Toaster";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
          </Route>

          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<RoleLanding />} />
              <Route path="/hierarchy" element={<NodesPage />} />
              <Route element={<RequireSuperuser />}>
                <Route path="/hierarchy/types" element={<NodeTypesPage />} />
                <Route path="/admin/users" element={<UsersPage />} />
                <Route
                  path="/admin/discovered-devices"
                  element={
                    <ClientOnlyRoute>
                      <DiscoveredDevicesPage />
                    </ClientOnlyRoute>
                  }
                />
                <Route
                  path="/admin/infra-targets"
                  element={
                    <ClientOnlyRoute>
                      <InfraTargetsPage />
                    </ClientOnlyRoute>
                  }
                />
              </Route>
              <Route
                path="/devices"
                element={
                  <ClientOnlyRoute>
                    <DevicesPage />
                  </ClientOnlyRoute>
                }
              />
              <Route path="/zones" element={<ZonesPage />} />
              <Route path="/zones/:tenantId/:zoneId" element={<ZoneDetailPage />} />
              <Route path="/profile" element={<Profile />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
