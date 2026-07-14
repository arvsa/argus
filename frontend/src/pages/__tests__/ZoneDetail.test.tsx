import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, AxiosHeaders } from "axios";
import { ZoneDetailPage } from "@/pages/ZoneDetail";
import { useAuthStore } from "@/store/auth";
import * as zonesApi from "@/api/zones";
import type { ClientSnapshot, ZoneSigningKey, ZoneSummary } from "@/api/zones";

vi.mock("@/api/zones", () => ({
  getZoneSummaries: vi.fn(),
  getLatestZoneSnapshot: vi.fn(),
  updateZoneDisplayName: vi.fn(),
  getZoneSigningKey: vi.fn(),
  registerZoneSigningKey: vi.fn(),
  deleteZone: vi.fn(),
}));

function snapshot(overrides: Partial<ClientSnapshot> = {}): ClientSnapshot {
  return {
    id: "snap-1",
    tenant_id: "acme",
    zone_id: "hq",
    snapshot_ts: 1700000300000,
    storage_key: "acme/hq/2026/07/09/12/1700000300000.json.gz",
    nodes_json: { "node-lobby": { up: 3, down: 1 } },
    devices_json: {
      "10.0.0.1": { ok: true, ts: 1700000200000 },
      "10.0.0.2": { ok: false, ts: 1700000100000 },
    },
    signature_verified: true,
    pulled_at: "2026-07-09T12:05:00Z",
    ...overrides,
  };
}

function summary(overrides: Partial<ZoneSummary> = {}): ZoneSummary {
  return {
    id: "zone-1",
    tenant_id: "acme",
    zone_id: "hq",
    up_count: 1,
    down_count: 1,
    last_snapshot_ts: 1700000300000,
    last_pulled_at: "2026-07-09T12:05:00Z",
    display_name: "Headquarters",
    is_stale: false,
    ...overrides,
  };
}

function http404(): AxiosError {
  return new AxiosError("Not Found", "ERR_BAD_REQUEST", undefined, undefined, {
    status: 404,
    statusText: "Not Found",
    data: { detail: "No snapshots" },
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/zones/acme/hq"]}>
        <Routes>
          <Route path="/zones" element={<div>Zones List Stub</div>} />
          <Route path="/zones/:tenantId/:zoneId" element={<ZoneDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function signingKey(overrides: Partial<ZoneSigningKey> = {}): ZoneSigningKey {
  return {
    id: "key-1",
    tenant_id: "acme",
    zone_id: "hq",
    public_key_hex: "ab".repeat(32),
    created_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

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

describe("ZoneDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setUser(true);
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [summary()], count: 1 });
    vi.mocked(zonesApi.getZoneSigningKey).mockRejectedValue(http404());
  });

  it("renders device states and node rollups from the latest snapshot", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(snapshot());
    renderPage();

    expect(await screen.findByText("10.0.0.1")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.2")).toBeInTheDocument();
    expect(screen.getByText("Up")).toBeInTheDocument();
    expect(screen.getByText("Down")).toBeInTheDocument();
    expect(screen.getByText("node-lobby")).toBeInTheDocument();
    expect(screen.getByText("3 up")).toBeInTheDocument();
    expect(screen.getByText("1 down")).toBeInTheDocument();
    expect(zonesApi.getLatestZoneSnapshot).toHaveBeenCalledWith("acme", "hq");
  });

  it("shows the operator display name and signature status in the header", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(snapshot());
    renderPage();

    expect(await screen.findByText("Headquarters")).toBeInTheDocument();
    expect(screen.getByText(/signature verified/i)).toBeInTheDocument();
  });

  it("labels an unverified signature and an unregistered key distinctly", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(
      snapshot({ signature_verified: null })
    );
    renderPage();

    expect(await screen.findByTestId("signature-badge")).toHaveTextContent(
      /no signing key registered/i
    );
  });

  it("renders a labeled empty state when the zone has no snapshots (404) -- not an error", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockRejectedValue(http404());
    renderPage();

    expect(await screen.findByText(/no snapshots ingested/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
  });

  it("still shows the signing key panel for a zone with no snapshot yet -- pre-registration", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockRejectedValue(http404());
    renderPage();

    expect(await screen.findByText(/no snapshots ingested/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /signing key/i })).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /public key/i })
    ).toBeInTheDocument();
  });

  it("renders an error state on a non-404 failure", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockRejectedValue(new Error("boom"));
    renderPage();

    expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument();
  });

  it("shows an 'unknown zone' empty state when neither a summary nor a signing key exists (typo'd tenant/zone)", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(zonesApi.getZoneSigningKey).mockRejectedValue(http404());
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockRejectedValue(http404());
    renderPage();

    expect(await screen.findByText(/no record of/i)).toBeInTheDocument();
    expect(screen.queryByText(/no snapshots ingested/i)).not.toBeInTheDocument();
  });

  it("still shows the plain 'no snapshots yet' empty state when a signing key is registered ahead of the first push", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(zonesApi.getZoneSigningKey).mockResolvedValue(signingKey());
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockRejectedValue(http404());
    renderPage();

    expect(await screen.findByText(/no snapshots ingested/i)).toBeInTheDocument();
    expect(screen.queryByText(/no record of/i)).not.toBeInTheDocument();
  });

  // ── Display name editing ────────────────────────────────────────────

  it("lets a superuser rename the zone from the detail page", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(snapshot());
    vi.mocked(zonesApi.updateZoneDisplayName).mockResolvedValue(
      summary({ display_name: "Main Campus" })
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole("button", { name: /edit display name/i })
    );
    const input = screen.getByRole("textbox", { name: /display name/i });
    await userEvent.clear(input);
    await userEvent.type(input, "Main Campus");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(zonesApi.updateZoneDisplayName).toHaveBeenCalledWith("acme", "hq", "Main Campus");
  });

  it("hides the rename control from non-superusers", async () => {
    setUser(false);
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(snapshot());
    renderPage();

    expect(await screen.findByText("Headquarters")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /edit display name/i })
    ).not.toBeInTheDocument();
  });

  it("hides rename and delete controls for a superuser when no zone summary row exists yet, even with a signing key pre-registered", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(zonesApi.getZoneSigningKey).mockResolvedValue(signingKey());
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockRejectedValue(http404());
    renderPage();

    expect(await screen.findByText(/no snapshots ingested/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /edit display name/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete zone/i })).not.toBeInTheDocument();
  });

  // ── Signing key management ──────────────────────────────────────────

  it("shows the registered signing key", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(snapshot());
    vi.mocked(zonesApi.getZoneSigningKey).mockResolvedValue(signingKey());
    renderPage();

    expect(await screen.findByText("ab".repeat(32))).toBeInTheDocument();
  });

  it("lets a superuser register a signing key when none is registered", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(snapshot());
    vi.mocked(zonesApi.registerZoneSigningKey).mockResolvedValue(
      signingKey({ public_key_hex: "cd".repeat(32) })
    );
    renderPage();

    const input = await screen.findByRole("textbox", { name: /public key/i });
    await userEvent.type(input, "cd".repeat(32));
    await userEvent.click(screen.getByRole("button", { name: /register/i }));

    expect(zonesApi.registerZoneSigningKey).toHaveBeenCalledWith(
      "acme",
      "hq",
      "cd".repeat(32)
    );
  });

  it("hides signing key registration from non-superusers", async () => {
    setUser(false);
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(snapshot());
    renderPage();

    expect(await screen.findByText("10.0.0.1")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /public key/i })
    ).not.toBeInTheDocument();
  });

  // ── Device table at realistic scale ─────────────────────────────────

  it("sorts down devices first, caps rendering, and filters by address", async () => {
    const devices: ClientSnapshot["devices_json"] = {};
    for (let i = 0; i < 250; i++) {
      devices[`10.1.${Math.floor(i / 250)}.${i}`] = { ok: true, ts: 1700000200000 };
    }
    devices["10.9.9.9"] = { ok: false, ts: 1700000200000 };
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(
      snapshot({ devices_json: devices })
    );
    renderPage();

    // Down device renders first even though it sorts last alphabetically.
    const table = await screen.findByRole("table", { name: /devices/i });
    const firstRow = within(table).getAllByRole("row")[0];
    expect(within(firstRow).getByText("10.9.9.9")).toBeInTheDocument();

    // 251 devices, capped render with a note.
    expect(screen.getByText(/showing 200 of 251/i)).toBeInTheDocument();

    // Filtering narrows to matches and lifts the cap note.
    await userEvent.type(screen.getByPlaceholderText(/filter/i), "10.9.9.9");
    expect(within(table).getAllByRole("row")).toHaveLength(1);
    expect(screen.queryByText(/showing 200/i)).not.toBeInTheDocument();
  });

  // ── Delete zone ──────────────────────────────────────────────────────

  it("lets a superuser delete the zone and navigates back to the list", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(snapshot());
    vi.mocked(zonesApi.deleteZone).mockResolvedValue(undefined);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /delete zone/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(zonesApi.deleteZone).toHaveBeenCalledWith("acme", "hq");
    expect(await screen.findByText("Zones List Stub")).toBeInTheDocument();
  });

  it("hides the delete control from non-superusers", async () => {
    setUser(false);
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockResolvedValue(snapshot());
    renderPage();

    expect(await screen.findByText("10.0.0.1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete zone/i })).not.toBeInTheDocument();
  });
});
