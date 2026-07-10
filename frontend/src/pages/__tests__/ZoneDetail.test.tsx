import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, AxiosHeaders } from "axios";
import { ZoneDetailPage } from "@/pages/ZoneDetail";
import * as zonesApi from "@/api/zones";
import type { ClientSnapshot, ZoneSummary } from "@/api/zones";

vi.mock("@/api/zones", () => ({
  getZoneSummaries: vi.fn(),
  getLatestZoneSnapshot: vi.fn(),
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
          <Route path="/zones/:tenantId/:zoneId" element={<ZoneDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ZoneDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [summary()], count: 1 });
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

    expect(await screen.findByText(/no signing key registered/i)).toBeInTheDocument();
  });

  it("renders a labeled empty state when the zone has no snapshots (404) -- not an error", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockRejectedValue(http404());
    renderPage();

    expect(await screen.findByText(/no snapshots ingested/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
  });

  it("renders an error state on a non-404 failure", async () => {
    vi.mocked(zonesApi.getLatestZoneSnapshot).mockRejectedValue(new Error("boom"));
    renderPage();

    expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument();
  });
});
