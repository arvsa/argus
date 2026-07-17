import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DiscoveredDevicesPage } from "@/pages/admin/DiscoveredDevices";
import * as discoveredDevicesApi from "@/api/discoveredDevices";
import type { DiscoveredDevice } from "@/api/discoveredDevices";

vi.mock("@/api/discoveredDevices", () => ({
  getDiscoveredDevices: vi.fn(),
  approveDiscoveredDevice: vi.fn(),
  rejectDiscoveredDevice: vi.fn(),
}));

function discovered(overrides: Partial<DiscoveredDevice> = {}): DiscoveredDevice {
  return {
    id: "disc-1",
    addr: "10.0.2.5",
    mac: "AA:BB:CC:DD:EE:01",
    hostname: null,
    discovered_via: "arp",
    status: "pending",
    first_seen_at: "2026-07-01T00:00:00Z",
    last_seen_at: "2026-07-01T00:00:00Z",
    is_stale: false,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DiscoveredDevicesPage />
    </QueryClientProvider>
  );
}

describe("DiscoveredDevicesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders discovery candidates once loaded", async () => {
    vi.mocked(discoveredDevicesApi.getDiscoveredDevices).mockResolvedValue({
      data: [discovered()],
      count: 1,
    });
    renderPage();

    expect(await screen.findByText("10.0.2.5")).toBeInTheDocument();
    expect(screen.getByText("AA:BB:CC:DD:EE:01")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("shows an empty state when there are no candidates", async () => {
    vi.mocked(discoveredDevicesApi.getDiscoveredDevices).mockResolvedValue({
      data: [],
      count: 0,
    });
    renderPage();

    expect(await screen.findByText(/no discovery candidates/i)).toBeInTheDocument();
  });

  it("shows an error state with retry when the request fails", async () => {
    vi.mocked(discoveredDevicesApi.getDiscoveredDevices).mockRejectedValue(new Error("boom"));
    renderPage();

    expect(await screen.findByText(/couldn't load discovered devices/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("flags a stale candidate", async () => {
    vi.mocked(discoveredDevicesApi.getDiscoveredDevices).mockResolvedValue({
      data: [discovered({ is_stale: true })],
      count: 1,
    });
    renderPage();

    expect(await screen.findByText(/stale/i)).toBeInTheDocument();
  });

  it("approves a candidate", async () => {
    vi.mocked(discoveredDevicesApi.getDiscoveredDevices).mockResolvedValue({
      data: [discovered()],
      count: 1,
    });
    vi.mocked(discoveredDevicesApi.approveDiscoveredDevice).mockResolvedValue(
      discovered({ status: "approved" })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /approve/i }));

    expect(discoveredDevicesApi.approveDiscoveredDevice).toHaveBeenCalledWith("disc-1");
  });

  it("rejects a candidate", async () => {
    vi.mocked(discoveredDevicesApi.getDiscoveredDevices).mockResolvedValue({
      data: [discovered()],
      count: 1,
    });
    vi.mocked(discoveredDevicesApi.rejectDiscoveredDevice).mockResolvedValue(
      discovered({ status: "rejected" })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /reject/i }));

    expect(discoveredDevicesApi.rejectDiscoveredDevice).toHaveBeenCalledWith("disc-1");
  });
});
