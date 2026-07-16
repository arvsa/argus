import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NodesPage } from "@/pages/hierarchy/Nodes";
import * as nodeTypesApi from "@/api/nodeTypes";
import * as nodesApi from "@/api/nodes";
import * as nodeStatsApi from "@/api/nodeStats";
import * as appConfigApi from "@/api/appConfig";
import * as deviceAssignmentsApi from "@/api/deviceAssignments";
import type { NodeType } from "@/api/nodeTypes";
import type { Node } from "@/api/nodes";

vi.mock("@/api/nodeTypes", () => ({
  getNodeTypes: vi.fn(),
}));
vi.mock("@/api/nodes", () => ({
  getNodes: vi.fn(),
  getNode: vi.fn(),
  createNode: vi.fn(),
  renameNode: vi.fn(),
  deleteNode: vi.fn(),
}));
vi.mock("@/api/nodeStats", () => ({
  getNodeStats: vi.fn(),
}));
vi.mock("@/api/appConfig", () => ({
  getAppConfig: vi.fn(),
}));
vi.mock("@/api/deviceAssignments", () => ({
  getDeviceAssignments: vi.fn(),
  createDeviceAssignment: vi.fn(),
  deleteDeviceAssignment: vi.fn(),
}));

function nodeType(overrides: Partial<NodeType> = {}): NodeType {
  return {
    id: "nt-region",
    tenant_id: "acme-corp",
    name: "Region",
    rank: 0,
    parent_type_id: null,
    created_at: null,
    ...overrides,
  };
}

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: "node-1",
    name: "Main Region",
    node_type_id: "nt-region",
    parent_id: null,
    path_ids: [],
    created_at: null,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NodesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("NodesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appConfigApi.getAppConfig).mockResolvedValue({ role: "client" });
    vi.mocked(nodeStatsApi.getNodeStats).mockResolvedValue({});
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(deviceAssignmentsApi.getDeviceAssignments).mockResolvedValue({
      data: [],
      count: 0,
    });
  });

  it("guides the operator to Hierarchy Types when no hierarchy shape is defined yet", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({ data: [], count: 0 });
    renderPage();

    expect(
      await screen.findByText(/no hierarchy configured yet/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /hierarchy types/i })
    ).toHaveAttribute("href", "/hierarchy/types");
    // The plain "No nodes yet." tree empty-state shouldn't also render --
    // there's nothing meaningful to browse until a shape exists.
    expect(screen.queryByText(/no nodes yet/i)).not.toBeInTheDocument();
  });

  it("renders the node tree normally once at least one hierarchy type exists", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({ data: [nodeType()], count: 1 });
    renderPage();

    expect(await screen.findByText(/no nodes yet/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/no hierarchy configured yet/i)
    ).not.toBeInTheDocument();
  });

  it("does not repeat the selected node's name as a duplicate heading", async () => {
    vi.mocked(nodeTypesApi.getNodeTypes).mockResolvedValue({ data: [nodeType()], count: 1 });
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Main Region" }));

    // "Main Region" legitimately appears twice: the tree row button, and
    // the breadcrumb's own bold last segment. A third, separate heading
    // repeating it verbatim (on top of the breadcrumb) is the bug under
    // test -- the breadcrumb's last segment already *is* the heading.
    expect(await screen.findByText("No devices assigned to this node yet.")).toBeInTheDocument();
    expect(screen.getAllByText("Main Region")).toHaveLength(2);
  });
});
