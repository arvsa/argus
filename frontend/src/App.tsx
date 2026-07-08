import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/layouts/AppShell";
import { AuthLayout } from "@/layouts/AuthLayout";
import { RequireAuth } from "@/layouts/RequireAuth";
import { Dashboard } from "@/pages/Dashboard";
import { Login } from "@/pages/Login";
import { Register } from "@/pages/Register";
import { ForgotPassword } from "@/pages/ForgotPassword";
import { ResetPassword } from "@/pages/ResetPassword";
import { Profile } from "@/pages/Profile";
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
              <Route path="/hierarchy" element={<ComingSoon title="Hierarchy" />} />
              <Route path="/hierarchy/types" element={<ComingSoon title="Hierarchy Types" />} />
              <Route path="/devices" element={<ComingSoon title="Devices" />} />
              <Route path="/zones" element={<ComingSoon title="Zones" />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/admin/users" element={<ComingSoon title="Users" />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
