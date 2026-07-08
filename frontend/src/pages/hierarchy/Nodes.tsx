import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NodeTree } from "@/components/NodeTree";
import { NodeBreadcrumb } from "@/components/NodeBreadcrumb";
import { PageHeader } from "@/components/PageHeader";
import { getNodeTypes } from "@/api/nodeTypes";
import type { Node } from "@/api/nodes";

export function NodesPage() {
  const [selected, setSelected] = useState<Node | null>(null);
  const { data: nodeTypesData } = useQuery({ queryKey: ["node-types"], queryFn: getNodeTypes });

  return (
    <div className="space-y-6">
      <PageHeader title="Hierarchy" description="Browse your organization's asset tree" />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <NodeTree
            parentId={null}
            selectedId={selected?.id}
            onSelect={setSelected}
            nodeTypes={nodeTypesData?.data ?? []}
          />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          {selected ? (
            <div className="space-y-3">
              <NodeBreadcrumb pathIds={selected.path_ids} currentName={selected.name} />
              <h2 className="text-sm font-semibold text-gray-900">{selected.name}</h2>
            </div>
          ) : (
            <p className="text-sm text-gray-500">Select a node to see details.</p>
          )}
        </div>
      </div>
    </div>
  );
}
