import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DevicesPage } from "@/pages/Devices";
import * as devicesApi from "@/api/devices";
import type { DeviceState } from "@/api/devices";

vi.mock("@/api/devices", () => ({
  getState: vi.fn(),
}));

function device(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    addr: "192.0.2.1",
    ok: true,
    ts: 1700000000000,
    interval_ms: 5000,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DevicesPage />
    </QueryClientProvider>
  );
}

describe("DevicesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders devices once loaded", async () => {
    vi.mocked(devicesApi.getState).mockResolvedValue({
      page: 1,
      size: 50,
      total: 2,
      items: [device({ addr: "192.0.2.1", ok: true }), device({ addr: "192.0.2.2", ok: false })],
    });
    renderPage();

    expect(await screen.findByText("192.0.2.1")).toBeInTheDocument();
    expect(screen.getByText("192.0.2.2")).toBeInTheDocument();
    expect(screen.getByText("Up")).toBeInTheDocument();
    expect(screen.getByText("Down")).toBeInTheDocument();
    expect(devicesApi.getState).toHaveBeenCalledWith({ page: 1, size: 50 });
  });

  it("shows an empty state when there are no devices", async () => {
    vi.mocked(devicesApi.getState).mockResolvedValue({ page: 1, size: 50, total: 0, items: [] });
    renderPage();

    expect(await screen.findByText(/no devices found/i)).toBeInTheDocument();
  });

  it("shows an error state with retry when the request fails", async () => {
    vi.mocked(devicesApi.getState).mockRejectedValue(new Error("network error"));
    renderPage();

    expect(await screen.findByText(/couldn't load devices/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("disables Previous and Next when there is only one page", async () => {
    vi.mocked(devicesApi.getState).mockResolvedValue({
      page: 1,
      size: 50,
      total: 1,
      items: [device()],
    });
    renderPage();

    await screen.findByText("192.0.2.1");
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("fetches the next page when Next is clicked", async () => {
    vi.mocked(devicesApi.getState).mockImplementation(({ page }) => {
      if (page === 1) {
        return Promise.resolve({
          page: 1,
          size: 50,
          total: 120,
          items: [device({ addr: "192.0.2.1" })],
        });
      }
      return Promise.resolve({
        page: 2,
        size: 50,
        total: 120,
        items: [device({ addr: "192.0.2.2" })],
      });
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("192.0.2.1");
    expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();
    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(await screen.findByText("192.0.2.2")).toBeInTheDocument();
    expect(devicesApi.getState).toHaveBeenCalledWith({ page: 2, size: 50 });
  });
});
