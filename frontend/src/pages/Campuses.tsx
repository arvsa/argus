import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, ChevronRight, MapPin } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getCampuses, createCampus, updateCampus, deleteCampus, type Campus } from "@/api/campuses";
import { useAuthStore } from "@/store/auth";
import { campusSchema, type CampusInput } from "@/lib/schemas";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { formatDate } from "@/lib/utils";

function CampusForm({
  defaultValues,
  onSubmit,
  loading,
}: {
  defaultValues?: CampusInput;
  onSubmit: (d: CampusInput) => void;
  loading?: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } =
    useForm<CampusInput>({ resolver: zodResolver(campusSchema), defaultValues });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Name *</label>
        <input
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          placeholder="Main Campus"
          {...register("name")}
        />
        {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Description</label>
        <textarea
          rows={3}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 resize-none"
          placeholder="Optional description…"
          {...register("description")}
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {loading ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

export function Campuses() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Campus | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["campuses"],
    queryFn: () => getCampuses(),
  });

  const createMut = useMutation({
    mutationFn: createCampus,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["campuses"] }); setCreateOpen(false); },
  });

  const updateMut = useMutation({
    mutationFn: (d: CampusInput) => updateCampus(editTarget!.id, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["campuses"] }); setEditTarget(null); },
  });

  const deleteMut = useMutation({
    mutationFn: deleteCampus,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campuses"] }),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Campuses"
        description={`${data?.count ?? 0} campus${data?.count !== 1 ? "es" : ""}`}
        action={
          user?.is_superuser ? (
            <button
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" /> New Campus
            </button>
          ) : undefined
        }
      />

      {isLoading ? (
        <PageSpinner />
      ) : !data?.data.length ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 py-16 text-gray-400">
          <MapPin className="h-10 w-10" />
          <p className="text-sm">No campuses yet</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden sm:table-cell">Description</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden md:table-cell">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.data.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <Link to={`/campuses/${c.id}`} className="hover:text-blue-600 flex items-center gap-1">
                      {c.name}
                      <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{c.description ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-400 hidden md:table-cell">{formatDate(c.created_at)}</td>
                  <td className="px-4 py-3">
                    {user?.is_superuser && (
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setEditTarget(c)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <ConfirmDialog
                          trigger={
                            <button className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          }
                          title="Delete campus"
                          description={`Delete "${c.name}"? This will cascade-delete all buildings, rooms, and devices within.`}
                          confirmLabel="Delete"
                          destructive
                          onConfirm={() => deleteMut.mutate(c.id)}
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

      <SlideOver open={createOpen} onOpenChange={setCreateOpen} title="New Campus">
        <CampusForm onSubmit={(d) => createMut.mutate(d)} loading={createMut.isPending} />
      </SlideOver>

      <SlideOver
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        title="Edit Campus"
      >
        {editTarget && (
          <CampusForm
            defaultValues={{ name: editTarget.name, description: editTarget.description }}
            onSubmit={(d) => updateMut.mutate(d)}
            loading={updateMut.isPending}
          />
        )}
      </SlideOver>
    </div>
  );
}
