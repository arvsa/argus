import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/layouts/AppShell";
import { AuthLayout } from "@/layouts/AuthLayout";
import { RequireAuth, RequireSuperuser } from "@/layouts/RequireAuth";
import { Dashboard } from "@/pages/Dashboard";
import { Login } from "@/pages/Login";
import { Register } from "@/pages/Register";
import { ForgotPassword } from "@/pages/ForgotPassword";
import { ResetPassword } from "@/pages/ResetPassword";
import { Profile } from "@/pages/Profile";
import { NodeTypesPage } from "@/pages/hierarchy/NodeTypes";
import { NodesPage } from "@/pages/hierarchy/Nodes";
import { DevicesPage } from "@/pages/Devices";
import { ZonesPage } from "@/pages/Zones";
import { Toaster } from "@/components/Toaster";

const queryClient = new QueryClient();

function ComingSoon({ title }: { title: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
      <p className="mt-2 text-sm text-gray-500">Coming soon.</p>
    </div>
  );
}

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
              <Route path="/" element={<Dashboard />} />
              <Route path="/hierarchy" element={<NodesPage />} />
              <Route element={<RequireSuperuser />}>
                <Route path="/hierarchy/types" element={<NodeTypesPage />} />
                <Route path="/admin/users" element={<ComingSoon title="Users" />} />
              </Route>
              <Route path="/devices" element={<DevicesPage />} />
              <Route path="/zones" element={<ZonesPage />} />
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
