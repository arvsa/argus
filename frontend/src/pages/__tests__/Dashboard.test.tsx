import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "@/pages/Dashboard";
import * as statsApi from "@/api/stats";

vi.mock("@/api/stats", () => ({
  getStats: vi.fn(),
}));

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows stats once loaded", async () => {
    vi.mocked(statsApi.getStats).mockResolvedValue({ total: 12, up: 10, down: 2 });
    renderDashboard();

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText(/total devices/i)).toBeInTheDocument();
    expect(screen.getByText(/^up$/i)).toBeInTheDocument();
    expect(screen.getByText(/^down$/i)).toBeInTheDocument();
  });

  it("shows an error state with retry when the request fails", async () => {
    vi.mocked(statsApi.getStats).mockRejectedValue(new Error("network error"));
    renderDashboard();

    expect(await screen.findByText(/couldn't load stats/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
