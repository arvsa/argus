import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, ChevronRight, Building2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getBuildings, createBuilding, updateBuilding, deleteBuilding, type Building } from "@/api/buildings";
import { getCampuses } from "@/api/campuses";
import { useAuthStore } from "@/store/auth";
import { buildingSchema, type BuildingInput } from "@/lib/schemas";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { useApiErrorToast } from "@/hooks/useErrorToast";
import { formatDate } from "@/lib/utils";

function BuildingForm({
  defaultValues,
  onSubmit,
  loading,
  campuses,
}: {
  defaultValues?: Partial<BuildingInput>;
  onSubmit: (d: BuildingInput) => void;
  loading?: boolean;
  campuses: { id: string; name: string }[];
}) {
  const { register, handleSubmit, formState: { errors } } =
    useForm<BuildingInput>({ resolver: zodResolver(buildingSchema), defaultValues });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Name *</label>
        <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...register("name")} />
        {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Campus *</label>
        <select className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 bg-white" {...register("campus_id")}>
          <option value="">Select campus…</option>
          {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {errors.campus_id && <p className="text-xs text-red-600">{errors.campus_id.message}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Description</label>
        <textarea rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 resize-none" {...register("description")} />
      </div>
      <button type="submit" disabled={loading} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
        {loading ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

export function Buildings() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Building | null>(null);

  const errorToast = useApiErrorToast();

  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["buildings"], queryFn: () => getBuildings() });
  const { data: campusesData } = useQuery({ queryKey: ["campuses"], queryFn: () => getCampuses() });
  const campuses = campusesData?.data ?? [];

  const campusName = (id: string) => campuses.find((c) => c.id === id)?.name ?? "—";

  const createMut = useMutation({
    mutationFn: createBuilding,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["buildings"] }); setCreateOpen(false); },
    onError: errorToast("Couldn't create building"),
  });

  const updateMut = useMutation({
    mutationFn: (d: BuildingInput) => updateBuilding(editTarget!.id, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["buildings"] }); setEditTarget(null); },
    onError: errorToast("Couldn't save building"),
  });

  const deleteMut = useMutation({
    mutationFn: deleteBuilding,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buildings"] }),
    onError: errorToast("Couldn't delete building"),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Buildings"
        description={`${data?.count ?? 0} building${data?.count !== 1 ? "s" : ""}`}
        action={
          user?.is_superuser ? (
            <button onClick={() => setCreateOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
              <Plus className="h-4 w-4" /> New Building
            </button>
          ) : undefined
        }
      />

      {isLoading ? <PageSpinner /> : isError ? (
        <ErrorState message="Couldn't load buildings." onRetry={() => refetch()} />
      ) : !data?.data.length ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-gray-300 py-16 text-gray-400">
          <Building2 className="h-10 w-10" />
          <p className="text-sm">No buildings yet</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden sm:table-cell">Campus</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden md:table-cell">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.data.map((b) => (
                <tr key={b.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <Link to={`/buildings/${b.id}`} className="hover:text-blue-600 flex items-center gap-1">
                      {b.name} <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{campusName(b.campus_id)}</td>
                  <td className="px-4 py-3 text-gray-400 hidden md:table-cell">{formatDate(b.created_at)}</td>
                  <td className="px-4 py-3">
                    {user?.is_superuser && (
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setEditTarget(b)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <ConfirmDialog
                          trigger={<button className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
                          title="Delete building"
                          description={`Delete "${b.name}"? All rooms and devices within will be removed.`}
                          confirmLabel="Delete" destructive
                          onConfirm={() => deleteMut.mutate(b.id)}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SlideOver open={createOpen} onOpenChange={setCreateOpen} title="New Building">
        <BuildingForm campuses={campuses} onSubmit={(d) => createMut.mutate(d)} loading={createMut.isPending} />
      </SlideOver>

      <SlideOver open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)} title="Edit Building">
        {editTarget && (
          <BuildingForm
            campuses={campuses}
            defaultValues={{ name: editTarget.name, campus_id: editTarget.campus_id, description: editTarget.description }}
            onSubmit={(d) => updateMut.mutate(d)}
            loading={updateMut.isPending}
          />
        )}
      </SlideOver>
    </div>
  );
}
