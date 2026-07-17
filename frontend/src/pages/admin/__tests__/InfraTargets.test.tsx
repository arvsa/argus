import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InfraTargetsPage } from "@/pages/admin/InfraTargets";
import * as infraTargetsApi from "@/api/infraTargets";
import type { InfraTarget } from "@/api/infraTargets";

vi.mock("@/api/infraTargets", () => ({
  getInfraTargets: vi.fn(),
  createInfraTarget: vi.fn(),
  updateInfraTarget: vi.fn(),
  deleteInfraTarget: vi.fn(),
}));

function target(overrides: Partial<InfraTarget> = {}): InfraTarget {
  return {
    id: "target-1",
    addr: "10.0.0.1",
    kind: "router",
    enabled: true,
    created_at: "2026-07-01T00:00:00Z",
    community_set: true,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <InfraTargetsPage />
    </QueryClientProvider>
  );
}

describe("InfraTargetsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders infra targets once loaded, never showing a plaintext community", async () => {
    vi.mocked(infraTargetsApi.getInfraTargets).mockResolvedValue({
      data: [target()],
      count: 1,
    });
    renderPage();

    expect(await screen.findByText("10.0.0.1")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /^router$/i })).toBeInTheDocument();
    // never renders the actual community string anywhere -- write-only
    expect(screen.queryByText(/public|private|secret/i)).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no targets", async () => {
    vi.mocked(infraTargetsApi.getInfraTargets).mockResolvedValue({ data: [], count: 0 });
    renderPage();

    expect(await screen.findByText(/no infrastructure targets/i)).toBeInTheDocument();
  });

  it("shows an error state with retry when the request fails", async () => {
    vi.mocked(infraTargetsApi.getInfraTargets).mockRejectedValue(new Error("boom"));
    renderPage();

    expect(await screen.findByText(/couldn't load infrastructure targets/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("adds a target via the Add form", async () => {
    vi.mocked(infraTargetsApi.getInfraTargets).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(infraTargetsApi.createInfraTarget).mockResolvedValue(target());
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(/no infrastructure targets/i);
    await user.click(screen.getByRole("button", { name: /add target/i }));
    await user.type(screen.getByLabelText(/address/i), "10.0.0.2");
    await user.selectOptions(screen.getByLabelText(/kind/i), "switch");
    await user.type(screen.getByLabelText(/community/i), "public");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(infraTargetsApi.createInfraTarget).toHaveBeenCalledWith({
      addr: "10.0.0.2",
      kind: "switch",
      community: "public",
    });
  });

  it("edits a target's kind and enabled state via the Edit form, leaving the community untouched", async () => {
    vi.mocked(infraTargetsApi.getInfraTargets).mockResolvedValue({
      data: [target()],
      count: 1,
    });
    vi.mocked(infraTargetsApi.updateInfraTarget).mockResolvedValue(
      target({ kind: "switch", enabled: false })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /edit 10.0.0.1/i }));
    await user.selectOptions(screen.getByLabelText(/kind/i), "switch");
    await user.click(screen.getByLabelText(/enabled/i));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(infraTargetsApi.updateInfraTarget).toHaveBeenCalledWith("target-1", {
      addr: "10.0.0.1",
      kind: "switch",
      enabled: false,
    });
  });

  it("only sends a new community string when the operator actually typed one", async () => {
    vi.mocked(infraTargetsApi.getInfraTargets).mockResolvedValue({
      data: [target()],
      count: 1,
    });
    vi.mocked(infraTargetsApi.updateInfraTarget).mockResolvedValue(target());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /edit 10.0.0.1/i }));
    await user.type(screen.getByLabelText(/community/i), "newsecret");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(infraTargetsApi.updateInfraTarget).toHaveBeenCalledWith("target-1", {
      addr: "10.0.0.1",
      kind: "router",
      enabled: true,
      community: "newsecret",
    });
  });

  it("removes a target after confirming", async () => {
    vi.mocked(infraTargetsApi.getInfraTargets).mockResolvedValue({
      data: [target()],
      count: 1,
    });
    vi.mocked(infraTargetsApi.deleteInfraTarget).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /delete 10.0.0.1/i }));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(infraTargetsApi.deleteInfraTarget).toHaveBeenCalledWith("target-1");
  });
});
