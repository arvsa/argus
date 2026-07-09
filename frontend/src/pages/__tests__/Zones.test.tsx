import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ZonesPage } from "@/pages/Zones";
import * as zonesApi from "@/api/zones";
import type { ZoneSummary } from "@/api/zones";

vi.mock("@/api/zones", () => ({
  getZoneSummaries: vi.fn(),
}));

function zone(overrides: Partial<ZoneSummary> = {}): ZoneSummary {
  return {
    id: "zone-1",
    tenant_id: "acme",
    zone_id: "hq",
    up_count: 10,
    down_count: 2,
    last_snapshot_ts: 1700000000000,
    last_pulled_at: "2024-01-01T00:00:00Z",
    is_stale: false,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ZonesPage />
    </QueryClientProvider>
  );
}

describe("ZonesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the not-configured empty state when there are no zones -- not an error", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [], count: 0 });
    renderPage();

    expect(await screen.findByText(/not configured for this deployment/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
  });

  it("renders zone summaries once loaded", async () => {
    vi.mocked(zonesApi.getZoneSummaries).mockResolvedValue({ data: [zone()], count: 1 });
    renderPage();

    expect(await screen.findByText("acme")).toBeInTheDocument();
    expect(screen.getByText("hq")).toBeInTheDocument();
    expect(screen.getByText("10 up")).toBeInTheDocument();
    expect(screen.getByText("2 down")).toBeInTheDocument();
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
});
