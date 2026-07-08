import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import {
  getNodeTypes,
  createNodeType,
  renameNodeType,
  deleteNodeType,
  type NodeType,
} from "@/api/nodeTypes";
import {
  firstNodeTypeSchema,
  appendNodeTypeSchema,
  renameNodeTypeSchema,
  type FirstNodeTypeInput,
  type AppendNodeTypeInput,
  type RenameNodeTypeInput,
} from "@/lib/schemas";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner, Spinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useApiErrorToast } from "@/hooks/useErrorToast";

const NODE_TYPES_KEY = ["node-types"];

function groupByTenant(types: NodeType[]): Map<string, NodeType[]> {
  const groups = new Map<string, NodeType[]>();
  for (const nt of types) {
    const list = groups.get(nt.tenant_id) ?? [];
    list.push(nt);
    groups.set(nt.tenant_id, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.rank - b.rank);
  return groups;
}

export function NodeTypesPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: NODE_TYPES_KEY,
    queryFn: getNodeTypes,
  });
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Hierarchy Types" description="Manage this tenant's rank chain" />

      {isLoading && <PageSpinner />}
      {isError && <ErrorState message="Couldn't load hierarchy types." onRetry={() => refetch()} />}

      {data && (() => {
        const groups = groupByTenant(data.data);
        const tenants = [...groups.keys()];

        if (tenants.length === 0) {
          return <FirstLevelForm />;
        }

        if (tenants.length === 1) {
          return <ChainList tenantId={tenants[0]} chain={groups.get(tenants[0])!} />;
        }

        if (selectedTenant) {
          return (
            <div className="space-y-3">
              <button
                onClick={() => setSelectedTenant(null)}
                className="text-sm text-blue-600 hover:underline"
              >
                ← Back to tenants
              </button>
              <ChainList tenantId={selectedTenant} chain={groups.get(selectedTenant)!} />
            </div>
          );
        }

        return (
          <div className="space-y-2">
            <p className="text-sm text-gray-500">
              Multiple tenants have hierarchy types configured. Choose one to manage:
            </p>
            {tenants.map((tenantId) => (
              <button
                key={tenantId}
                onClick={() => setSelectedTenant(tenantId)}
                className="block w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-left text-sm font-medium text-gray-800 hover:bg-gray-50"
              >
                {tenantId}
              </button>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

function FirstLevelForm() {
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();
  const { register, handleSubmit, formState: { errors, isSubmitting }, reset } =
    useForm<FirstNodeTypeInput>({ resolver: zodResolver(firstNodeTypeSchema) });

  const mutation = useMutation({
    mutationFn: (d: FirstNodeTypeInput) =>
      createNodeType({ tenant_id: d.tenant_id, name: d.name, rank: 0, parent_type_id: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NODE_TYPES_KEY });
      reset();
    },
    onError: errorToast("Couldn't create hierarchy type"),
  });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">No hierarchy configured yet</h2>
        <p className="mt-1 text-sm text-gray-500">
          Create the first (root) level to get started -- e.g. "Region" or "Campus".
        </p>
      </div>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="first-node-type-tenant-id" className="text-sm font-medium text-gray-700">Tenant ID</label>
          <input
            id="first-node-type-tenant-id"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
            {...register("tenant_id")}
          />
          {errors.tenant_id && <p className="text-xs text-red-600">{errors.tenant_id.message}</p>}
        </div>
        <div className="space-y-1">
          <label htmlFor="first-node-type-name" className="text-sm font-medium text-gray-700">Root level name</label>
          <input
            id="first-node-type-name"
            placeholder="Region"
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
          Create root level
        </button>
      </form>
    </div>
  );
}

function ChainList({ tenantId, chain }: { tenantId: string; chain: NodeType[] }) {
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();
  const [appendOpen, setAppendOpen] = useState(false);
  const [renaming, setRenaming] = useState<NodeType | null>(null);

  const appendMutation = useMutation({
    mutationFn: (d: AppendNodeTypeInput) => {
      const last = chain[chain.length - 1];
      return createNodeType({
        tenant_id: tenantId,
        name: d.name,
        rank: last.rank + 1,
        parent_type_id: last.id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NODE_TYPES_KEY });
      setAppendOpen(false);
    },
    onError: errorToast("Couldn't add level"),
  });

  const renameMutation = useMutation({
    mutationFn: (d: { id: string; name: string }) => renameNodeType(d.id, d.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NODE_TYPES_KEY });
      setRenaming(null);
    },
    onError: errorToast("Couldn't rename level"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteNodeType(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NODE_TYPES_KEY }),
    onError: errorToast("Couldn't delete level"),
  });

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
        <p className="text-sm font-medium text-gray-700">
          Tenant: <span className="font-mono text-gray-900">{tenantId}</span>
        </p>
        <button
          onClick={() => setAppendOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" /> Add level
        </button>
      </div>
      <ul>
        {chain.map((nt, i) => {
          const isLast = i === chain.length - 1;
          return (
            <li
              key={nt.id}
              className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3 last:border-0"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                  {nt.rank}
                </span>
                <button
                  onClick={() => setRenaming(nt)}
                  className="text-sm font-medium text-gray-800 hover:text-blue-700 hover:underline"
                >
                  {nt.name}
                </button>
              </div>
              {isLast && (
                // Only the deepest level can be deleted: parent_type_id has
                // ondelete=CASCADE, so deleting a root/middle level would
                // silently cascade-delete every level below it too -- not
                // just fail if nodes exist. Mirrors the append-only
                // symmetry already enforced on creation (verified live
                // against the real API during Phase 2a).
                <ConfirmDialog
                  trigger={
                    <button className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600" aria-label={`Delete ${nt.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  }
                  title={`Delete "${nt.name}"?`}
                  description="This fails if any node still uses this level. This cannot be undone."
                  confirmLabel="Delete"
                  destructive
                  onConfirm={() => deleteMutation.mutate(nt.id)}
                />
              )}
            </li>
          );
        })}
      </ul>

      <SlideOver open={appendOpen} onOpenChange={setAppendOpen} title="Add level" description={`Appends to the end of the ${tenantId} chain`}>
        <AppendForm onSubmit={(d) => appendMutation.mutate(d)} isSubmitting={appendMutation.isPending} />
      </SlideOver>

      <SlideOver
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="Rename level"
      >
        {renaming && (
          <RenameForm
            currentName={renaming.name}
            onSubmit={(name) => renameMutation.mutate({ id: renaming.id, name })}
            isSubmitting={renameMutation.isPending}
          />
        )}
      </SlideOver>
    </div>
  );
}

function AppendForm({ onSubmit, isSubmitting }: { onSubmit: (d: AppendNodeTypeInput) => void; isSubmitting: boolean }) {
  const { register, handleSubmit, formState: { errors } } =
    useForm<AppendNodeTypeInput>({ resolver: zodResolver(appendNodeTypeSchema) });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="append-node-type-name" className="text-sm font-medium text-gray-700">Name</label>
        <input
          id="append-node-type-name"
          autoFocus
          placeholder="Building"
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
        Add level
      </button>
    </form>
  );
}

function RenameForm({
  currentName,
  onSubmit,
  isSubmitting,
}: {
  currentName: string;
  onSubmit: (name: string) => void;
  isSubmitting: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<RenameNodeTypeInput>({
    resolver: zodResolver(renameNodeTypeSchema),
    defaultValues: { name: currentName },
  });
  return (
    <form onSubmit={handleSubmit((d) => onSubmit(d.name))} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="rename-node-type-name" className="text-sm font-medium text-gray-700">Name</label>
        <input
          id="rename-node-type-name"
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
        Save
      </button>
    </form>
  );
}
