import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  getInfraTargets,
  createInfraTarget,
  updateInfraTarget,
  deleteInfraTarget,
  type InfraTarget,
} from "@/api/infraTargets";
import {
  infraTargetCreateSchema,
  infraTargetUpdateSchema,
  type InfraTargetCreateInput,
  type InfraTargetUpdateInput,
} from "@/lib/schemas";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner, Spinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useApiErrorToast } from "@/hooks/useErrorToast";

const INFRA_TARGETS_KEY = ["infra-targets"];

// Which routers/switches pingsvc's discovery subsystem should poll via
// SNMP for ARP-table discovery (plan/device-discovery-v1.md §2.6 /
// plan/device-naming-and-bulk-import-v1.md §2.4). The community string is
// write-only -- never echoed back once set, same convention as the
// encryption-key panel in plan/optional-snapshot-encryption-v1.md.
export function InfraTargetsPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<InfraTarget | null>(null);
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: INFRA_TARGETS_KEY,
    queryFn: getInfraTargets,
  });

  const createMutation = useMutation({
    mutationFn: (d: InfraTargetCreateInput) => createInfraTarget(d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INFRA_TARGETS_KEY });
      setAddOpen(false);
    },
    onError: errorToast("Couldn't add infrastructure target"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: InfraTargetUpdateInput }) =>
      updateInfraTarget(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INFRA_TARGETS_KEY });
      setEditTarget(null);
    },
    onError: errorToast("Couldn't update infrastructure target"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteInfraTarget(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INFRA_TARGETS_KEY }),
    onError: errorToast("Couldn't remove infrastructure target"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Infrastructure targets"
        description="Routers and switches pingsvc polls via SNMP to discover devices from their ARP tables"
        action={
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add target
          </button>
        }
      />

      {isLoading && <PageSpinner />}
      {isError && (
        <ErrorState message="Couldn't load infrastructure targets." onRetry={() => refetch()} />
      )}

      {data && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {data.data.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No infrastructure targets configured yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5">Address</th>
                    <th className="px-4 py-2.5">Kind</th>
                    <th className="px-4 py-2.5">Community</th>
                    <th className="px-4 py-2.5">Enabled</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.data.map((t) => (
                    <tr key={t.id}>
                      <td className="px-4 py-2.5 font-mono text-gray-800">{t.addr}</td>
                      <td className="px-4 py-2.5 text-gray-600 capitalize">{t.kind}</td>
                      <td className="px-4 py-2.5 text-gray-500">
                        {t.community_set ? "•••••••• (set)" : "Not set"}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">{t.enabled ? "Yes" : "No"}</td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => setEditTarget(t)}
                            className="shrink-0 rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-600"
                            aria-label={`Edit ${t.addr}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <ConfirmDialog
                            trigger={
                              <button
                                className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                aria-label={`Delete ${t.addr}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            }
                            title={`Delete "${t.addr}"?`}
                            description="pingsvc will stop polling this target for discovery. This cannot be undone."
                            confirmLabel="Delete"
                            destructive
                            onConfirm={() => deleteMutation.mutate(t.id)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <SlideOver open={addOpen} onOpenChange={setAddOpen} title="Add infrastructure target">
        <AddInfraTargetForm
          onSubmit={(d) => createMutation.mutate(d)}
          isSubmitting={createMutation.isPending}
        />
      </SlideOver>

      <SlideOver
        open={editTarget !== null}
        onOpenChange={(open) => !open && setEditTarget(null)}
        title="Edit infrastructure target"
      >
        {editTarget && (
          <EditInfraTargetForm
            target={editTarget}
            onSubmit={(d) => {
              // Only send community when the operator actually typed a new
              // one -- write-only, same convention as the create form.
              const { community, ...rest } = d;
              updateMutation.mutate({
                id: editTarget.id,
                data: community ? { ...rest, community } : rest,
              });
            }}
            isSubmitting={updateMutation.isPending}
          />
        )}
      </SlideOver>
    </div>
  );
}

function AddInfraTargetForm({
  onSubmit,
  isSubmitting,
}: {
  onSubmit: (d: InfraTargetCreateInput) => void;
  isSubmitting: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<InfraTargetCreateInput>({
    resolver: zodResolver(infraTargetCreateSchema),
    defaultValues: { kind: "router" },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="infra-target-addr" className="text-sm font-medium text-gray-700">
          Address
        </label>
        <input
          id="infra-target-addr"
          autoFocus
          placeholder="10.0.0.1"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("addr")}
        />
        {errors.addr && <p className="text-xs text-red-600">{errors.addr.message}</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor="infra-target-kind" className="text-sm font-medium text-gray-700">
          Kind
        </label>
        <select
          id="infra-target-kind"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("kind")}
        >
          <option value="router">Router</option>
          <option value="switch">Switch</option>
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="infra-target-community" className="text-sm font-medium text-gray-700">
          Community
        </label>
        <input
          id="infra-target-community"
          type="password"
          placeholder="SNMP v2c community string"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("community")}
        />
        {errors.community && <p className="text-xs text-red-600">{errors.community.message}</p>}
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

function EditInfraTargetForm({
  target,
  onSubmit,
  isSubmitting,
}: {
  target: InfraTarget;
  onSubmit: (d: InfraTargetUpdateInput) => void;
  isSubmitting: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<InfraTargetUpdateInput>({
    resolver: zodResolver(infraTargetUpdateSchema),
    defaultValues: { addr: target.addr, kind: target.kind, enabled: target.enabled },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="infra-target-edit-addr" className="text-sm font-medium text-gray-700">
          Address
        </label>
        <input
          id="infra-target-edit-addr"
          autoFocus
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("addr")}
        />
        {errors.addr && <p className="text-xs text-red-600">{errors.addr.message}</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor="infra-target-edit-kind" className="text-sm font-medium text-gray-700">
          Kind
        </label>
        <select
          id="infra-target-edit-kind"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("kind")}
        >
          <option value="router">Router</option>
          <option value="switch">Switch</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
        <input type="checkbox" className="h-4 w-4 rounded border-gray-300" {...register("enabled")} />
        Enabled
      </label>
      <div className="space-y-1">
        <label htmlFor="infra-target-edit-community" className="text-sm font-medium text-gray-700">
          Community
        </label>
        <input
          id="infra-target-edit-community"
          type="password"
          placeholder="Leave blank to keep unchanged"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("community")}
        />
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
