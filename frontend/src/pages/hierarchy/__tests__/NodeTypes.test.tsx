import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NodeTypesPage } from "@/pages/hierarchy/NodeTypes";
import * as nodeTypesApi from "@/api/nodeTypes";
import type { NodeType } from "@/api/nodeTypes";

vi.mock("@/api/nodeTypes", () => ({
  getNodeTypes: vi.fn(),
  createNodeType: vi.fn(),
  renameNodeType: vi.fn(),
  deleteNodeType: vi.fn(),
}));

function nt(overrides: Partial<NodeType> = {}): NodeType {
  return {
    id: "nt-1",
    tenant_id: "acme",
    name: "Region",
    rank: 0,
    parent_type_id: null,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NodeTypesPage />
    </QueryClientProvider>
  );
}

describe("NodeTypesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a bootstrap form when no hierarchy types exist yet", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({ data: [], count: 0 });
    renderPage();

    expect(await screen.findByText(/no hierarchy configured yet/i)).toBeInTheDocument();
  });

  it("creates the first root level from the bootstrap form", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(nodeTypesApi.createNodeType).mockResolvedValue(nt());
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(/no hierarchy configured yet/i);
    await user.type(screen.getByLabelText(/tenant id/i), "acme");
    await user.type(screen.getByLabelText(/root level name/i), "Region");
    await user.click(screen.getByRole("button", { name: /create root level/i }));

    expect(nodeTypesApi.createNodeType).toHaveBeenCalledWith({
      tenant_id: "acme",
      name: "Region",
      rank: 0,
      parent_type_id: null,
    });
  });

  it("renders a single tenant's chain sorted by rank", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({
      data: [
        nt({ id: "nt-2", name: "Site", rank: 1, parent_type_id: "nt-1" }),
        nt({ id: "nt-1", name: "Region", rank: 0 }),
      ],
      count: 2,
    });
    renderPage();

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Region");
    expect(items[1]).toHaveTextContent("Site");
  });

  it("appends a new level to the end of the chain", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({ data: [nt()], count: 1 });
    vi.mocked(nodeTypesApi.createNodeType).mockResolvedValue(
      nt({ id: "nt-2", name: "Site", rank: 1, parent_type_id: "nt-1" })
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Region");
    await user.click(screen.getByRole("button", { name: /add level/i }));
    await user.type(screen.getByLabelText(/^name$/i), "Site");
    await user.click(screen.getByRole("button", { name: /^add level$/i }));

    expect(nodeTypesApi.createNodeType).toHaveBeenCalledWith({
      tenant_id: "acme",
      name: "Site",
      rank: 1,
      parent_type_id: "nt-1",
    });
  });

  it("renames a level", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({ data: [nt()], count: 1 });
    vi.mocked(nodeTypesApi.renameNodeType).mockResolvedValue(nt({ name: "Zone" }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Region" }));
    const nameInput = screen.getByLabelText(/^name$/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Zone");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(nodeTypesApi.renameNodeType).toHaveBeenCalledWith("nt-1", "Zone");
  });

  it("deletes the only level in a single-level chain after confirming", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({ data: [nt()], count: 1 });
    vi.mocked(nodeTypesApi.deleteNodeType).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /delete region/i }));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(nodeTypesApi.deleteNodeType).toHaveBeenCalledWith("nt-1");
  });

  it("only allows deleting the last (deepest) level in a multi-level chain", async () => {
    // parent_type_id has ondelete=CASCADE, so deleting a root/middle level
    // would silently cascade-delete every level below it -- verified live
    // against the real API. Only the last level should offer a delete
    // action; earlier levels must be deleted bottom-up.
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({
      data: [
        nt({ id: "nt-1", name: "Region", rank: 0 }),
        nt({ id: "nt-2", name: "Site", rank: 1, parent_type_id: "nt-1" }),
      ],
      count: 2,
    });
    renderPage();

    await screen.findByText("Region");
    expect(screen.queryByRole("button", { name: /delete region/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete site/i })).toBeInTheDocument();
  });

  it("shows a tenant picker when more than one tenant exists", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({
      data: [nt({ tenant_id: "acme" }), nt({ id: "nt-3", tenant_id: "globex", name: "Site" })],
      count: 2,
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(/multiple tenants/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "acme" }));

    expect(await screen.findByText("Region")).toBeInTheDocument();
    expect(screen.getByText("← Back to tenants")).toBeInTheDocument();
  });
});
