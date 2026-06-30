import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/layouts/AppShell";
import { AuthLayout } from "@/layouts/AuthLayout";
import { RequireAuth, RequireSuperuser } from "@/layouts/RequireAuth";
import { Login } from "@/pages/Login";
import { Register } from "@/pages/Register";
import { ForgotPassword } from "@/pages/ForgotPassword";
import { ResetPassword } from "@/pages/ResetPassword";
import { Dashboard } from "@/pages/Dashboard";
import { Campuses } from "@/pages/Campuses";
import { CampusDetail } from "@/pages/CampusDetail";
import { Buildings } from "@/pages/Buildings";
import { BuildingDetail } from "@/pages/BuildingDetail";
import { Rooms } from "@/pages/Rooms";
import { RoomDetail } from "@/pages/RoomDetail";
import { Devices } from "@/pages/Devices";
import { DeviceDetail } from "@/pages/DeviceDetail";
import { Profile } from "@/pages/Profile";
import { AdminUsers } from "@/pages/admin/Users";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Toaster } from "@/components/Toaster";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

function WsBootstrap() {
  useWebSocket();
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <WsBootstrap />
        <Toaster />
        <Routes>
          {/* Public auth routes */}
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
          </Route>

          {/* Protected app routes */}
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/campuses" element={<Campuses />} />
              <Route path="/campuses/:id" element={<CampusDetail />} />
              <Route path="/buildings" element={<Buildings />} />
              <Route path="/buildings/:id" element={<BuildingDetail />} />
              <Route path="/rooms" element={<Rooms />} />
              <Route path="/rooms/:id" element={<RoomDetail />} />
              <Route path="/devices" element={<Devices />} />
              <Route path="/devices/:id" element={<DeviceDetail />} />
              <Route path="/profile" element={<Profile />} />

              {/* Superuser only */}
              <Route element={<RequireSuperuser />}>
                <Route path="/admin/users" element={<AdminUsers />} />
              </Route>
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
