import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ZoneIdentityCard } from "@/components/ZoneIdentityCard";
import * as zoneIdentityApi from "@/api/zoneIdentity";

vi.mock("@/api/zoneIdentity", () => ({
  getZoneIdentity: vi.fn(),
}));

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ZoneIdentityCard />
    </QueryClientProvider>
  );
}

describe("ZoneIdentityCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("shows zone_id, tenant_id, and the signing public key once loaded", async () => {
    vi.mocked(zoneIdentityApi.getZoneIdentity).mockResolvedValue({
      zone_id: "zone-1",
      tenant_id: "acme-corp",
      public_key_hex: "ab".repeat(32),
    });
    renderCard();

    expect(await screen.findByText("zone-1")).toBeInTheDocument();
    expect(screen.getByText("acme-corp")).toBeInTheDocument();
    expect(screen.getByText("ab".repeat(32))).toBeInTheDocument();
  });

  it("explains the pubkey is unavailable when the exporter hasn't generated one yet", async () => {
    vi.mocked(zoneIdentityApi.getZoneIdentity).mockResolvedValue({
      zone_id: "zone-1",
      tenant_id: "acme-corp",
      public_key_hex: null,
    });
    renderCard();

    expect(await screen.findByText("zone-1")).toBeInTheDocument();
    expect(screen.getByText(/no signing key yet/i)).toBeInTheDocument();
  });

  it("copies the public key to the clipboard when its copy button is clicked", async () => {
    vi.mocked(zoneIdentityApi.getZoneIdentity).mockResolvedValue({
      zone_id: "zone-1",
      tenant_id: "acme-corp",
      public_key_hex: "cd".repeat(32),
    });
    renderCard();

    const copyButton = await screen.findByRole("button", { name: /copy public key/i });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("cd".repeat(32));
    });
  });

  it("shows an error state when the request fails (e.g. pingsvc unreachable)", async () => {
    vi.mocked(zoneIdentityApi.getZoneIdentity).mockRejectedValue(new Error("503"));
    renderCard();

    expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument();
  });
});
