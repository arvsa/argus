import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FolderTree } from "lucide-react";
import { NodeTree } from "@/components/NodeTree";
import { NodeBreadcrumb } from "@/components/NodeBreadcrumb";
import { AssignedDevices } from "@/components/AssignedDevices";
import { PageHeader } from "@/components/PageHeader";
import { getNodeTypes } from "@/api/nodeTypes";
import type { Node } from "@/api/nodes";

export function NodesPage() {
  const [selected, setSelected] = useState<Node | null>(null);
  const { data: nodeTypesData, isLoading: nodeTypesLoading } = useQuery({
    queryKey: ["node-types"],
    queryFn: getNodeTypes,
  });

  // Nothing meaningful to browse or assign until at least one hierarchy
  // level is defined -- without this, a brand-new tenant just sees
  // NodeTree's plain "No nodes yet." with no indication that Hierarchy
  // Types is the actual next step.
  if (!nodeTypesLoading && nodeTypesData && nodeTypesData.data.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Hierarchy" description="Browse your organization's asset tree" />
        <div className="flex flex-col items-center gap-3 rounded-xl border border-gray-200 bg-white py-16 text-gray-500">
          <FolderTree className="h-8 w-8 text-gray-300" />
          <p className="text-sm font-medium text-gray-700">No hierarchy configured yet</p>
          <p className="max-w-sm text-center text-sm text-gray-500">
            Define at least one level (e.g. "Region" or "Campus") before you can create nodes
            or assign devices.
          </p>
          <Link
            to="/hierarchy/types"
            className="mt-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Go to Hierarchy Types
          </Link>
        </div>
      </div>
    );
  }

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
              {/* The breadcrumb's own bold last segment already is the
                  selected node's name -- a separate heading repeating it
                  verbatim would just be redundant. */}
              <NodeBreadcrumb pathIds={selected.path_ids} currentName={selected.name} />
              <AssignedDevices nodeId={selected.id} />
            </div>
          ) : (
            <p className="text-sm text-gray-500">Select a node to see details.</p>
          )}
        </div>
      </div>
    </div>
  );
}
