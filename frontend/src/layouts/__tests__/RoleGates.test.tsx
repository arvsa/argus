import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoleLanding, ClientOnlyRoute } from "@/layouts/RoleGates";
import * as appConfigApi from "@/api/appConfig";

vi.mock("@/api/appConfig", () => ({
  getAppConfig: vi.fn(),
}));

vi.mock("@/pages/Dashboard", () => ({
  Dashboard: () => <div>Dashboard Stub</div>,
}));

function renderLanding() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RoleLanding />} />
          <Route path="/zones" element={<div>Zones Stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderGated() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/devices"]}>
        <Routes>
          <Route path="/" element={<div>Home Stub</div>} />
          <Route
            path="/devices"
            element={
              <ClientOnlyRoute>
                <div>Devices Stub</div>
              </ClientOnlyRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("RoleLanding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the Dashboard on a client deployment", async () => {
    vi.mocked(appConfigApi.getAppConfig).mockResolvedValue({ role: "client" });
    renderLanding();
    expect(await screen.findByText("Dashboard Stub")).toBeInTheDocument();
  });

  it("redirects to /zones on a server deployment", async () => {
    vi.mocked(appConfigApi.getAppConfig).mockResolvedValue({ role: "server" });
    renderLanding();
    expect(await screen.findByText("Zones Stub")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard Stub")).not.toBeInTheDocument();
  });
});

describe("ClientOnlyRoute", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders children on a client deployment", async () => {
    vi.mocked(appConfigApi.getAppConfig).mockResolvedValue({ role: "client" });
    renderGated();
    expect(await screen.findByText("Devices Stub")).toBeInTheDocument();
  });

  it("redirects home on a server deployment", async () => {
    vi.mocked(appConfigApi.getAppConfig).mockResolvedValue({ role: "server" });
    renderGated();
    expect(await screen.findByText("Home Stub")).toBeInTheDocument();
    expect(screen.queryByText("Devices Stub")).not.toBeInTheDocument();
  });
});
