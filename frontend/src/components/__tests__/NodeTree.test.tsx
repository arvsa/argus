import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NodeTree } from "@/components/NodeTree";
import * as nodesApi from "@/api/nodes";
import type { Node } from "@/api/nodes";
import type { NodeType } from "@/api/nodeTypes";

vi.mock("@/api/nodes", () => ({
  getNodes: vi.fn(),
  createNode: vi.fn(),
  renameNode: vi.fn(),
  deleteNode: vi.fn(),
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

function nodeType(overrides: Partial<NodeType> = {}): NodeType {
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

  it("shows an Add root node button when a root NodeType exists", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [], count: 0 });
    renderTree({ nodeTypes: [nodeType()] });

    expect(await screen.findByRole("button", { name: /add root node/i })).toBeInTheDocument();
  });

  it("hides the Add root node button when no root NodeType exists", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [], count: 0 });
    renderTree({ nodeTypes: [] });

    await screen.findByText(/no nodes yet/i);
    expect(screen.queryByRole("button", { name: /add root node/i })).not.toBeInTheDocument();
  });

  it("creates a root node from the Add root form", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(nodesApi.createNode).mockResolvedValue(node());
    const user = userEvent.setup();
    renderTree({ nodeTypes: [nodeType()] });

    await user.click(await screen.findByRole("button", { name: /add root node/i }));
    await user.type(screen.getByLabelText(/^name$/i), "Main Campus");
    await user.click(screen.getByRole("button", { name: /^add node$/i }));

    expect(nodesApi.createNode).toHaveBeenCalledWith({
      name: "Main Campus",
      node_type_id: "nt-1",
      parent_id: null,
    });
  });

  it("shows an Add child button only when a child NodeType exists for the node's type", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    renderTree({
      nodeTypes: [nodeType(), nodeType({ id: "nt-2", name: "Site", rank: 1, parent_type_id: "nt-1" })],
    });

    expect(await screen.findByRole("button", { name: /add child to main campus/i })).toBeInTheDocument();
  });

  it("hides the Add child button when the node's type is the deepest level", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    renderTree({ nodeTypes: [nodeType()] });

    await screen.findByText("Main Campus");
    expect(screen.queryByRole("button", { name: /add child to main campus/i })).not.toBeInTheDocument();
  });

  it("creates a child node scoped to the correct node_type_id and parent_id", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    vi.mocked(nodesApi.createNode).mockResolvedValue(
      node({ id: "n-2", name: "Building A", parent_id: "n-1" })
    );
    const user = userEvent.setup();
    renderTree({
      nodeTypes: [nodeType(), nodeType({ id: "nt-2", name: "Site", rank: 1, parent_type_id: "nt-1" })],
    });

    await user.click(await screen.findByRole("button", { name: /add child to main campus/i }));
    await user.type(screen.getByLabelText(/^name$/i), "Building A");
    await user.click(screen.getByRole("button", { name: /^add node$/i }));

    expect(nodesApi.createNode).toHaveBeenCalledWith({
      name: "Building A",
      node_type_id: "nt-2",
      parent_id: "n-1",
    });
  });

  it("renames a node", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    vi.mocked(nodesApi.renameNode).mockResolvedValue(node({ name: "HQ" }));
    const user = userEvent.setup();
    renderTree();

    await user.click(await screen.findByRole("button", { name: /rename main campus/i }));
    const nameInput = screen.getByLabelText(/^name$/i);
    await user.clear(nameInput);
    await user.type(nameInput, "HQ");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(nodesApi.renameNode).toHaveBeenCalledWith("n-1", "HQ");
  });

  it("deletes a node after confirming", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    vi.mocked(nodesApi.deleteNode).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderTree();

    await user.click(await screen.findByRole("button", { name: /delete main campus/i }));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(nodesApi.deleteNode).toHaveBeenCalledWith("n-1");
  });

  it("clears the selection when the selected node is deleted", async () => {
    vi.mocked(nodesApi.getNodes).mockResolvedValue({ data: [node()], count: 1 });
    vi.mocked(nodesApi.deleteNode).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { onSelect } = renderTree({ selectedId: "n-1" });

    await user.click(await screen.findByRole("button", { name: /delete main campus/i }));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
