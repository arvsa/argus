import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Folder, Plus, Trash2 } from "lucide-react";
import { getNodes, createNode, renameNode, deleteNode, type Node } from "@/api/nodes";
import { getNodeStats, type NodeStats } from "@/api/nodeStats";
import type { NodeType } from "@/api/nodeTypes";
import { nodeCreateSchema, type NodeCreateInput, nodeNameSchema, type NodeNameInput } from "@/lib/schemas";
import { Spinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { NodeStatusBadge } from "@/components/NodeStatusBadge";
import { useApiErrorToast } from "@/hooks/useErrorToast";
import { useAppConfig } from "@/hooks/useAppConfig";
import { cn } from "@/lib/utils";

// Poll fallback for per-node aggregate counts -- the WS envelope (Phase 3c's
// useLiveFeed) invalidates ["node-stats"] on every events:node:<id> message
// for near-real-time updates, but this keeps counts eventually correct even
// if the WebSocket is down (see plan/frontend-v2.md Phase 3d).
const NODE_STATS_POLL_INTERVAL_MS = 15_000;

interface NodeTreeProps {
  parentId: string | null;
  selectedId?: string | null;
  onSelect: (node: Node | null) => void;
  depth?: number;
  nodeTypes?: NodeType[];
}

// Returns every NodeType that's a valid choice for a given position (root,
// or child of a given parent type) -- today's NodeTypesPage only ever
// builds one linear chain per tenant, so this is usually a single-element
// array, but it doesn't assume that: if a tenant ever has more than one
// candidate type at a position, the create form surfaces a picker instead
// of silently guessing (see NodeCreateForm below).
function findRootTypes(types: NodeType[]): NodeType[] {
  return types.filter((t) => t.parent_type_id === null);
}

function findChildTypes(types: NodeType[], parentTypeId: string): NodeType[] {
  return types.filter((t) => t.parent_type_id === parentTypeId);
}

// Recursive, depth-agnostic tree: each level is its own lazy-loaded query
// keyed by parent id, so expanding a node fetches only its direct children
// (GET /nodes/?parent_id=<id>) rather than pulling the whole tree upfront.
export function NodeTree({ parentId, selectedId, onSelect, depth = 0, nodeTypes = [] }: NodeTreeProps) {
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();
  const { role } = useAppConfig();
  const [addRootOpen, setAddRootOpen] = useState(false);
  const rootTypes = depth === 0 ? findRootTypes(nodeTypes) : [];

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["nodes", parentId],
    queryFn: () => getNodes({ parentId }),
  });

  const nodeIds = data?.data.map((n) => n.id) ?? [];
  const { data: nodeStats } = useQuery({
    queryKey: ["node-stats", parentId],
    queryFn: () => getNodeStats(nodeIds),
    // /node-stats lives in the ping-pipeline router, which a server
    // deployment doesn't mount -- skip the poll instead of 404ing forever.
    enabled: nodeIds.length > 0 && role === "client",
    refetchInterval: NODE_STATS_POLL_INTERVAL_MS,
  });

  const createRootMutation = useMutation({
    mutationFn: (d: NodeCreateInput) => createNode({ name: d.name, node_type_id: d.node_type_id, parent_id: null }),
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
      {depth === 0 && rootTypes.length > 0 && (
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
              stats={nodeStats?.[node.id]}
            />
          ))}
        </ul>
      )}

      {rootTypes.length > 0 && (
        <SlideOver
          open={addRootOpen}
          onOpenChange={setAddRootOpen}
          title="Add root node"
        >
          <NodeCreateForm
            nodeTypes={rootTypes}
            submitLabel="Add node"
            onSubmit={(d) => createRootMutation.mutate(d)}
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
  stats,
}: {
  node: Node;
  selectedId?: string | null;
  onSelect: (node: Node | null) => void;
  depth: number;
  nodeTypes: NodeType[];
  listParentId: string | null;
  stats: NodeStats[string] | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [addChildOpen, setAddChildOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const isSelected = node.id === selectedId;

  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();
  const childTypes = findChildTypes(nodeTypes, node.node_type_id);

  const createChildMutation = useMutation({
    mutationFn: (d: NodeCreateInput) =>
      createNode({ name: d.name, node_type_id: d.node_type_id, parent_id: node.id }),
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
        <div className="shrink-0">
          <NodeStatusBadge up={stats?.up} down={stats?.down} />
        </div>
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {childTypes.length > 0 && (
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

      {childTypes.length > 0 && (
        <SlideOver
          open={addChildOpen}
          onOpenChange={setAddChildOpen}
          title={`Add child to ${node.name}`}
        >
          <NodeCreateForm
            nodeTypes={childTypes}
            submitLabel="Add node"
            onSubmit={(d) => createChildMutation.mutate(d)}
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

// Node creation, unlike rename, also needs a NodeType -- this is the one
// place Hierarchy Types (the admin-defined shape) becomes a visible choice
// when building the actual tree. With exactly one candidate type (today's
// common case, since NodeTypesPage only builds one linear chain per
// tenant) it's auto-selected and the field is hidden, preserving the
// original one-click UX; with more than one, a required Type select is
// shown.
function NodeCreateForm({
  nodeTypes,
  submitLabel,
  onSubmit,
  isSubmitting,
}: {
  nodeTypes: NodeType[];
  submitLabel: string;
  onSubmit: (data: NodeCreateInput) => void;
  isSubmitting: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<NodeCreateInput>({
    resolver: zodResolver(nodeCreateSchema),
    defaultValues: { name: "", node_type_id: nodeTypes.length === 1 ? nodeTypes[0].id : "" },
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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
      {nodeTypes.length > 1 && (
        <div className="space-y-1">
          <label htmlFor="node-type" className="text-sm font-medium text-gray-700">Type</label>
          <select
            id="node-type"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
            {...register("node_type_id")}
          >
            <option value="" disabled>
              Select a type
            </option>
            {nodeTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {errors.node_type_id && <p className="text-xs text-red-600">{errors.node_type_id.message}</p>}
        </div>
      )}
      {nodeTypes.length === 1 && <input type="hidden" {...register("node_type_id")} />}
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
