import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, ChevronRight, Building2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getCampus, updateCampus, deleteCampus } from "@/api/campuses";
import { getBuildings, createBuilding, type Building } from "@/api/buildings";
import { useAuthStore } from "@/store/auth";
import { campusSchema, buildingSchema, type CampusInput, type BuildingInput } from "@/lib/schemas";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { HierarchyBreadcrumb } from "@/components/HierarchyBreadcrumb";
import { PageSpinner } from "@/components/Spinner";
import { formatDate } from "@/lib/utils";

export function CampusDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [addBldgOpen, setAddBldgOpen] = useState(false);

  const { data: campus, isLoading: campusLoading } = useQuery({
    queryKey: ["campus", id],
    queryFn: () => getCampus(id!),
    enabled: !!id,
  });

  const { data: buildingsData, isLoading: bldgsLoading } = useQuery({
    queryKey: ["buildings"],
    queryFn: () => getBuildings(),
  });

  const campusBuildings = (buildingsData?.data ?? []).filter((b) => b.campus_id === id);

  const updateMut = useMutation({
    mutationFn: (d: CampusInput) => updateCampus(id!, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["campus", id] }); setEditOpen(false); },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteCampus(id!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["campuses"] }); navigate("/campuses"); },
  });

  const createBldgMut = useMutation({
    mutationFn: createBuilding,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["buildings"] }); setAddBldgOpen(false); },
  });

  const { register: regCampus, handleSubmit: hsCampus, reset: resetCampus, formState: { errors: errCampus } } =
    useForm<CampusInput>({
      resolver: zodResolver(campusSchema),
      defaultValues: { name: campus?.name, description: campus?.description },
    });

  useEffect(() => {
    if (campus) resetCampus({ name: campus.name, description: campus.description });
  }, [campus]);

  const { register: regBldg, handleSubmit: hsBldg, formState: { errors: errBldg } } =
    useForm<BuildingInput>({
      resolver: zodResolver(buildingSchema),
      defaultValues: { campus_id: id },
    });

  if (campusLoading) return <PageSpinner />;
  if (!campus) return <p className="text-sm text-gray-500">Campus not found.</p>;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <HierarchyBreadcrumb crumbs={[{ label: "Campuses", to: "/campuses" }, { label: campus.name }]} />
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold text-gray-900">{campus.name}</h1>
          {user?.is_superuser && (
            <div className="flex items-center gap-2">
              <button onClick={() => setEditOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
              <ConfirmDialog
                trigger={
                  <button className="flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50">
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                }
                title="Delete campus"
                description={`Delete "${campus.name}"? All buildings, rooms, and devices within will be permanently removed.`}
                confirmLabel="Delete"
                destructive
                onConfirm={() => deleteMut.mutate()}
              />
            </div>
          )}
        </div>
        {campus.description && <p className="text-sm text-gray-500">{campus.description}</p>}
        <p className="text-xs text-gray-400">Created {formatDate(campus.created_at)}</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-900">
            Buildings ({campusBuildings.length})
          </h2>
          {user?.is_superuser && (
            <button
              onClick={() => setAddBldgOpen(true)}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add Building
            </button>
          )}
        </div>

        {bldgsLoading ? <PageSpinner /> : campusBuildings.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-300 py-12 text-gray-400">
            <Building2 className="h-8 w-8" />
            <p className="text-sm">No buildings yet</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {campusBuildings.map((b: Building) => (
              <Link
                key={b.id}
                to={`/buildings/${b.id}`}
                className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4 shadow-sm hover:border-blue-300 hover:shadow-md transition-all"
              >
                <div>
                  <p className="font-medium text-gray-900">{b.name}</p>
                  {b.description && <p className="text-xs text-gray-400 mt-0.5">{b.description}</p>}
                </div>
                <ChevronRight className="h-4 w-4 text-gray-400" />
              </Link>
            ))}
          </div>
        )}
      </div>

      <SlideOver open={editOpen} onOpenChange={setEditOpen} title="Edit Campus">
        <form onSubmit={hsCampus((d) => updateMut.mutate(d))} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Name *</label>
            <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...regCampus("name")} />
            {errCampus.name && <p className="text-xs text-red-600">{errCampus.name.message}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Description</label>
            <textarea rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 resize-none" {...regCampus("description")} />
          </div>
          <button type="submit" disabled={updateMut.isPending} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {updateMut.isPending ? "Saving…" : "Save"}
          </button>
        </form>
      </SlideOver>

      <SlideOver open={addBldgOpen} onOpenChange={setAddBldgOpen} title="Add Building">
        <form onSubmit={hsBldg((d) => createBldgMut.mutate(d))} className="space-y-4">
          <input type="hidden" {...regBldg("campus_id")} />
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Name *</label>
            <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...regBldg("name")} />
            {errBldg.name && <p className="text-xs text-red-600">{errBldg.name.message}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Description</label>
            <textarea rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 resize-none" {...regBldg("description")} />
          </div>
          <button type="submit" disabled={createBldgMut.isPending} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {createBldgMut.isPending ? "Creating…" : "Create Building"}
          </button>
        </form>
      </SlideOver>
    </div>
  );
}
