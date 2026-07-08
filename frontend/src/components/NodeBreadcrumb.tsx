import { useQueries } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { getNode } from "@/api/nodes";

interface Props {
  pathIds: string[];
  currentName: string;
}

// Built from a Node's denormalized path_ids (root-first ancestor id array)
// rather than assuming a fixed number of ancestor fields -- replaces the
// old fixed-depth HierarchyBreadcrumb. path_ids only carries ids, so each
// ancestor's name is resolved via useQueries -- this hits the React Query
// cache for any ancestor already fetched while browsing the tree, and
// falls back to a fresh GET /nodes/{id} otherwise (e.g. a deep link
// straight to a node whose ancestors were never expanded).
export function NodeBreadcrumb({ pathIds, currentName }: Props) {
  const queries = useQueries({
    queries: pathIds.map((id) => ({
      queryKey: ["nodes", "detail", id],
      queryFn: () => getNode(id),
    })),
  });

  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm text-gray-500" aria-label="Breadcrumb">
      {queries.map((q, i) => (
        <span key={pathIds[i]} className="flex items-center gap-1">
          <span>{q.isLoading ? "…" : (q.data?.name ?? "?")}</span>
          <ChevronRight className="h-3 w-3 shrink-0" />
        </span>
      ))}
      <span className="font-medium text-gray-900">{currentName}</span>
    </nav>
  );
}
