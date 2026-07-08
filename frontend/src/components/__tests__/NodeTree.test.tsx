import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NodeTree } from "@/components/NodeTree";
import * as nodesApi from "@/api/nodes";
import type { Node } from "@/api/nodes";

vi.mock("@/api/nodes", () => ({
  getNodes: vi.fn(),
}));

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: "n-1",
    name: "Main Campus",
    node_type_id: "nt-1",
    parent_id: null,
    path_ids: [],
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderTree(props: Partial<Parameters<typeof NodeTree>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelect = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <NodeTree parentId={null} onSelect={onSelect} {...props} />
    </QueryClientProvider>
  );
  return { onSelect };
}

describe("NodeTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a message when the root has no nodes", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [], count: 0 });
    renderTree();

    expect(await screen.findByText(/no nodes yet/i)).toBeInTheDocument();
  });

  it("renders root nodes and fetches with parentId null", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    renderTree();

    expect(await screen.findByText("Main Campus")).toBeInTheDocument();
    expect(nodesApi.getNodes).toHaveBeenCalledWith({ parentId: null });
  });

  it("calls onSelect when a node's name is clicked", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    const user = userEvent.setup();
    const { onSelect } = renderTree();

    await user.click(await screen.findByText("Main Campus"));
    expect(onSelect).toHaveBeenCalledWith(node());
  });

  it("lazily fetches and renders children when expanded", async () => {
    const root = node();
    const child = node({ id: "n-2", name: "Building A", parent_id: "n-1", path_ids: ["n-1"] });
    vi.mocked(nodesApi.getNodes).mockImplementation(({ parentId }) => {
      if (parentId === null) return Promise.resolve({ data: [root], count: 1 });
      if (parentId === "n-1") return Promise.resolve({ data: [child], count: 1 });
      return Promise.resolve({ data: [], count: 0 });
    });
    const user = userEvent.setup();
    renderTree();

    await screen.findByText("Main Campus");
    expect(screen.queryByText("Building A")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /expand main campus/i }));

    expect(await screen.findByText("Building A")).toBeInTheDocument();
    expect(nodesApi.getNodes).toHaveBeenCalledWith({ parentId: "n-1" });
  });

  it("highlights the selected node", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    renderTree({ selectedId: "n-1" });

    const row = await screen.findByText("Main Campus");
    expect(row.closest("div")).toHaveClass("bg-blue-50");
  });
});
