import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NodeBreadcrumb } from "@/components/NodeBreadcrumb";
import * as nodesApi from "@/api/nodes";
import type { Node } from "@/api/nodes";

vi.mock("@/api/nodes", () => ({
  getNode: vi.fn(),
}));

function node(id: string, name: string): Node {
  return { id, name, node_type_id: "nt-1", parent_id: null, path_ids: [], created_at: null };
}

function renderBreadcrumb(pathIds: string[], currentName: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NodeBreadcrumb pathIds={pathIds} currentName={currentName} />
    </QueryClientProvider>
  );
}

describe("NodeBreadcrumb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders just the current name when there are no ancestors", () => {
    renderBreadcrumb([], "Main Campus");
    expect(screen.getByText("Main Campus")).toBeInTheDocument();
    expect(nodesApi.getNode).not.toHaveBeenCalled();
  });

  it("resolves and renders each ancestor's name in root-first order", async () => {
    vi.mocked(nodesApi.getNode).mockImplementation((id: string) =>
      Promise.resolve(id === "root-1" ? node("root-1", "Region") : node("mid-1", "Site"))
    );
    renderBreadcrumb(["root-1", "mid-1"], "Rack 3");

    expect(await screen.findByText("Region")).toBeInTheDocument();
    expect(await screen.findByText("Site")).toBeInTheDocument();
    expect(screen.getByText("Rack 3")).toBeInTheDocument();
    expect(nodesApi.getNode).toHaveBeenCalledWith("root-1");
    expect(nodesApi.getNode).toHaveBeenCalledWith("mid-1");
  });
});
