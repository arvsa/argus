import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { getNodes, type Node } from "@/api/nodes";
import { Spinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { cn } from "@/lib/utils";

interface NodeTreeProps {
  parentId: string | null;
  selectedId?: string | null;
  onSelect: (node: Node) => void;
  depth?: number;
}

// Recursive, depth-agnostic tree: each level is its own lazy-loaded query
// keyed by parent id, so expanding a node fetches only its direct children
// (GET /nodes/?parent_id=<id>) rather than pulling the whole tree upfront.
export function NodeTree({ parentId, selectedId, onSelect, depth = 0 }: NodeTreeProps) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["nodes", parentId],
    queryFn: () => getNodes({ parentId }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 pl-2 text-sm text-gray-400">
        <Spinner className="h-3.5 w-3.5" /> Loading…
      </div>
    );
  }

  if (isError) {
    return <ErrorState message="Couldn't load nodes." onRetry={() => refetch()} />;
  }

  if (!data || data.data.length === 0) {
    // At the root, an empty tree is worth a real message; a leaf with no
    // children (there's no has-children flag to know in advance) just
    // renders nothing when expanded.
    return depth === 0 ? <p className="py-4 text-sm text-gray-500">No nodes yet.</p> : null;
  }

  return (
    <ul className={depth > 0 ? "ml-4 border-l border-gray-100 pl-2" : undefined}>
      {data.data.map((node) => (
        <NodeRow key={node.id} node={node} selectedId={selectedId} onSelect={onSelect} depth={depth} />
      ))}
    </ul>
  );
}

function NodeRow({
  node,
  selectedId,
  onSelect,
  depth,
}: {
  node: Node;
  selectedId?: string | null;
  onSelect: (node: Node) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = node.id === selectedId;

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm",
          isSelected ? "bg-blue-50 font-medium text-blue-700" : "hover:bg-gray-50"
        )}
      >
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-gray-400 hover:text-gray-600"
          aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <button onClick={() => onSelect(node)} className="flex min-w-0 items-center gap-1.5 truncate text-left">
          <Folder className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {expanded && <NodeTree parentId={node.id} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />}
    </li>
  );
}
