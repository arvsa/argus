import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ZonesPage } from "@/pages/Zones";
import { useAuthStore } from "@/store/auth";
import * as zonesApi from "@/api/zones";
import * as appConfigApi from "@/api/appConfig";
import * as zoneIdentityApi from "@/api/zoneIdentity";
import type { ZoneSummary } from "@/api/zones";

vi.mock("@/api/zones", () => ({
  getZoneSummaries: vi.fn(),
}));
vi.mock("@/api/appConfig", () => ({
  getAppConfig: vi.fn(),
}));
vi.mock("@/api/zoneIdentity", () => ({
  getZoneIdentity: vi.fn(),
}));

function setUser(isSuperuser: boolean) {
  useAuthStore.setState({
    token: "t",
    user: {
      id: "u1",
      email: "op@example.com",
      full_name: "Operator",
      is_active: true,
      is_superuser: isSuperuser,
      admission_status: "approved",
      created_at: "2024-01-01T00:00:00Z",
    },
  });
}

function zone(overrides: Partial<ZoneSummary> = {}): ZoneSummary {
  return {
    id: "zone-1",
    tenant_id: "acme",
    zone_id: "hq",
    up_count: 10,
    down_count: 2,
    last_snapshot_ts: 1700000000000,
    last_pulled_at: "2024-01-01T00:00:00Z",
    display_name: null,
    is_stale: false,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/zones"]}>
        <Routes>
          <Route path="/zones" element={<ZonesPage />} />
          <Route path="/zones/:tenantId/:zoneId" element={<div>Zone Detail Stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ZonesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to "server" -- most of these tests are about the zones list
    // itself, which is a server-role concern; the client-role empty-state
    // swap gets its own tests below.
    vi.mocked(appConfigApi.getAppConfig).mockResolvedValue({ role: "server" });
  });

  it("shows the not-configured empty state when there are no zones on a server -- not an error", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [], count: 0 });
    renderPage();

    expect(await screen.findByText(/not configured for this deployment/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
  });

  it("shows this zone's identity instead of the generic empty state on a client", async () => {
    vi.mocked(appConfigApi.getAppConfig).mockResolvedValue({ role: "client" });
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(zoneIdentityApi.getZoneIdentity).mockResolvedValue({
      zone_id: "zone-1",
      tenant_id: "acme-corp",
      public_key_hex: "ab".repeat(32),
    });
    renderPage();

    expect(await screen.findByText("zone-1")).toBeInTheDocument();
    expect(screen.queryByText(/not configured for this deployment/i)).not.toBeInTheDocument();
  });

  it("renders zone summaries once loaded", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [zone()], count: 1 });
    renderPage();

    expect(await screen.findByText("acme")).toBeInTheDocument();
    expect(screen.getByText("hq")).toBeInTheDocument();
    expect(screen.getByText("10 up")).toBeInTheDocument();
    expect(screen.getByText("2 down")).toBeInTheDocument();
  });

  it("shows the operator display name when set", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({
      data: [zone({ display_name: "Headquarters" })],
      count: 1,
    });
    renderPage();

    expect(await screen.findByText("Headquarters")).toBeInTheDocument();
  });

  it("navigates to the zone detail page when a row is clicked", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [zone()], count: 1 });
    renderPage();

    fireEvent.click(await screen.findByText("hq"));
    expect(await screen.findByText("Zone Detail Stub")).toBeInTheDocument();
  });

  it("shows a stale badge for a stale zone", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [zone({ is_stale: true })], count: 1 });
    renderPage();

    expect(await screen.findByText(/stale/i)).toBeInTheDocument();
  });

  it("shows a fresh badge for a non-stale zone", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [zone({ is_stale: false })], count: 1 });
    renderPage();

    expect(await screen.findByText(/fresh/i)).toBeInTheDocument();
  });

  it("shows an error state with retry when the request fails -- distinct from the empty state", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockRejectedValue(new Error("network error"));
    renderPage();

    expect(await screen.findByText(/couldn't load zones/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText(/not configured for this deployment/i)).not.toBeInTheDocument();
  });

  // ── Add zone ─────────────────────────────────────────────────────────

  it("navigates to a typed tenant/zone id from the Add zone form", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [], count: 0 });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /add zone/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /tenant id/i }), "acme-corp");
    await userEvent.type(screen.getByRole("textbox", { name: /zone id/i }), "zone-3");
    await userEvent.click(screen.getByRole("button", { name: /^go$/i }));

    expect(await screen.findByText("Zone Detail Stub")).toBeInTheDocument();
  });

  it("hides the Add zone control from non-superusers", async () => {
    setUser(false);
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [], count: 0 });
    renderPage();

    expect(await screen.findByText(/not configured for this deployment/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add zone/i })).not.toBeInTheDocument();
  });
});
