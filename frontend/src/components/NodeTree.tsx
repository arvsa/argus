import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Folder, Plus, Trash2 } from "lucide-react";
import { getNodes, createNode, renameNode, deleteNode, type Node } from "@/api/nodes";
import type { NodeType } from "@/api/nodeTypes";
import { nodeNameSchema, type NodeNameInput } from "@/lib/schemas";
import { Spinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useApiErrorToast } from "@/hooks/useErrorToast";
import { cn } from "@/lib/utils";

interface NodeTreeProps {
  parentId: string | null;
  selectedId?: string | null;
  onSelect: (node: Node | null) => void;
  depth?: number;
  nodeTypes?: NodeType[];
}

// A tenant's rank chain is linear (NodeType.parent_type_id), so each type
// has at most one direct child type -- these just walk that chain rather
// than assuming any particular rank numbering.
function findRootType(types: NodeType[]): NodeType | undefined {
  const roots = types.filter((t) => t.parent_type_id === null);
  return roots.length === 1 ? roots[0] : undefined;
}

function findChildType(types: NodeType[], parentTypeId: string): NodeType | undefined {
  return types.find((t) => t.parent_type_id === parentTypeId);
}

// Recursive, depth-agnostic tree: each level is its own lazy-loaded query
// keyed by parent id, so expanding a node fetches only its direct children
// (GET /nodes/?parent_id=<id>) rather than pulling the whole tree upfront.
export function NodeTree({ parentId, selectedId, onSelect, depth = 0, nodeTypes = [] }: NodeTreeProps) {
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();
  const [addRootOpen, setAddRootOpen] = useState(false);
  const rootType = depth === 0 ? findRootType(nodeTypes) : undefined;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["nodes", parentId],
    queryFn: () => getNodes({ parentId }),
  });

  const createRootMutation = useMutation({
    mutationFn: (d: NodeNameInput) =>
      createNode({ name: d.name, node_type_id: rootType!.id, parent_id: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nodes", null] });
      setAddRootOpen(false);
    },
    onError: errorToast("Couldn't create node"),
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

  const rows = data?.data ?? [];

  return (
    <div>
      {depth === 0 && rootType && (
        <div className="mb-2 flex justify-end">
          <button
            onClick={() => setAddRootOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add root node
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        // At the root, an empty tree is worth a real message; a leaf with
        // no children (there's no has-children flag to know in advance)
        // just renders nothing when expanded.
        depth === 0 && <p className="py-4 text-sm text-gray-500">No nodes yet.</p>
      ) : (
        <ul className={depth > 0 ? "ml-4 border-l border-gray-100 pl-2" : undefined}>
          {rows.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth}
              nodeTypes={nodeTypes}
              listParentId={parentId}
            />
          ))}
        </ul>
      )}

      {rootType && (
        <SlideOver
          open={addRootOpen}
          onOpenChange={setAddRootOpen}
          title="Add root node"
        >
          <NodeNameForm
            submitLabel="Add node"
            onSubmit={(name) => createRootMutation.mutate({ name })}
            isSubmitting={createRootMutation.isPending}
          />
        </SlideOver>
      )}
    </div>
  );
}

function NodeRow({
  node,
  selectedId,
  onSelect,
  depth,
  nodeTypes,
  listParentId,
}: {
  node: Node;
  selectedId?: string | null;
  onSelect: (node: Node | null) => void;
  depth: number;
  nodeTypes: NodeType[];
  listParentId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [addChildOpen, setAddChildOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const isSelected = node.id === selectedId;

  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();
  const childType = findChildType(nodeTypes, node.node_type_id);

  const createChildMutation = useMutation({
    mutationFn: (d: NodeNameInput) =>
      createNode({ name: d.name, node_type_id: childType!.id, parent_id: node.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nodes", node.id] });
      setAddChildOpen(false);
      setExpanded(true);
    },
    onError: errorToast("Couldn't create node"),
  });

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameNode(node.id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nodes", listParentId] });
      setRenaming(false);
    },
    onError: errorToast("Couldn't rename node"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteNode(node.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nodes", listParentId] });
      if (isSelected) onSelect(null);
    },
    onError: errorToast("Couldn't delete node"),
  });

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm",
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
        <button onClick={() => onSelect(node)} className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left">
          <Folder className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <span className="truncate">{node.name}</span>
        </button>
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {childType && (
            <button
              onClick={() => setAddChildOpen(true)}
              className="rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-600"
              aria-label={`Add child to ${node.name}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => setRenaming(true)}
            className="rounded px-1.5 py-1 text-xs font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label={`Rename ${node.name}`}
          >
            Rename
          </button>
          <ConfirmDialog
            trigger={
              <button className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" aria-label={`Delete ${node.name}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            }
            title={`Delete "${node.name}"?`}
            description="This cascades to any descendant nodes. This cannot be undone."
            confirmLabel="Delete"
            destructive
            onConfirm={() => deleteMutation.mutate()}
          />
        </div>
      </div>

      {expanded && (
        <NodeTree
          parentId={node.id}
          selectedId={selectedId}
          onSelect={onSelect}
          depth={depth + 1}
          nodeTypes={nodeTypes}
        />
      )}

      {childType && (
        <SlideOver
          open={addChildOpen}
          onOpenChange={setAddChildOpen}
          title={`Add child to ${node.name}`}
        >
          <NodeNameForm
            submitLabel="Add node"
            onSubmit={(name) => createChildMutation.mutate({ name })}
            isSubmitting={createChildMutation.isPending}
          />
        </SlideOver>
      )}

      <SlideOver open={renaming} onOpenChange={setRenaming} title="Rename node">
        {renaming && (
          <NodeNameForm
            defaultName={node.name}
            submitLabel="Save"
            onSubmit={(name) => renameMutation.mutate(name)}
            isSubmitting={renameMutation.isPending}
          />
        )}
      </SlideOver>
    </li>
  );
}

function NodeNameForm({
  defaultName,
  submitLabel,
  onSubmit,
  isSubmitting,
}: {
  defaultName?: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  isSubmitting: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<NodeNameInput>({
    resolver: zodResolver(nodeNameSchema),
    defaultValues: { name: defaultName ?? "" },
  });
  return (
    <form onSubmit={handleSubmit((d) => onSubmit(d.name))} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="node-name" className="text-sm font-medium text-gray-700">Name</label>
        <input
          id="node-name"
          autoFocus
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("name")}
        />
        {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isSubmitting && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
        {submitLabel}
      </button>
    </form>
  );
}
