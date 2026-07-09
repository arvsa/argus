import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/layouts/AppShell";
import { useAuthStore } from "@/store/auth";
import * as appConfigApi from "@/api/appConfig";

vi.mock("@/api/appConfig", () => ({
  getAppConfig: vi.fn(),
}));

// The live feed opens a real WebSocket -- out of scope here, covered in
// useLiveFeed.test.tsx.
vi.mock("@/hooks/useLiveFeed", () => ({
  LiveFeedProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLiveFeed: () => ({ status: "open", events: [] }),
}));

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Page Body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AppShell role-aware navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      token: "t",
      user: {
        id: "u1",
        email: "op@example.com",
        full_name: "Operator",
        is_active: true,
        is_superuser: true,
        admission_status: "approved",
        created_at: "2024-01-01T00:00:00Z",
      },
    });
  });

  it("client role: shows the full local-stack nav and the WS indicator", async () => {
    vi.mocked(appConfigApi.getAppConfig).mockResolvedValue({ role: "client" });
    renderShell();

    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Devices")).toBeInTheDocument();
    expect(screen.getByText("Zones")).toBeInTheDocument();
    expect(screen.getByText("Hierarchy")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("server role: hides ping-pipeline nav and the WS indicator", async () => {
    vi.mocked(appConfigApi.getAppConfig).mockResolvedValue({ role: "server" });
    renderShell();

    expect(await screen.findByText("Zones")).toBeInTheDocument();
    expect(screen.getByText("Hierarchy")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText("Devices")).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    // Admin nav is role-independent.
    expect(screen.getByText("Users")).toBeInTheDocument();
  });
});
