import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, ChevronRight, Monitor } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getBuilding, updateBuilding, deleteBuilding } from "@/api/buildings";
import { getCampus } from "@/api/campuses";
import { getRooms, createRoom, type Room } from "@/api/rooms";
import { useAuthStore } from "@/store/auth";
import { buildingSchema, roomSchema, type BuildingInput, type RoomInput } from "@/lib/schemas";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { HierarchyBreadcrumb } from "@/components/HierarchyBreadcrumb";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { useApiErrorToast } from "@/hooks/useErrorToast";
import { formatDate } from "@/lib/utils";

export function BuildingDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [addRoomOpen, setAddRoomOpen] = useState(false);

  const { data: building, isLoading } = useQuery({
    queryKey: ["building", id],
    queryFn: () => getBuilding(id!),
    enabled: !!id,
  });

  const { data: campus } = useQuery({
    queryKey: ["campus", building?.campus_id],
    queryFn: () => getCampus(building!.campus_id),
    enabled: !!building?.campus_id,
  });

  const errorToast = useApiErrorToast();

  const { data: roomsData, isLoading: roomsLoading, isError: roomsError, refetch: refetchRooms } = useQuery({
    queryKey: ["rooms"],
    queryFn: () => getRooms(),
  });

  const buildingRooms = (roomsData?.data ?? []).filter((r) => r.building_id === id);

  const updateMut = useMutation({
    mutationFn: (d: BuildingInput) => updateBuilding(id!, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["building", id] }); setEditOpen(false); },
    onError: errorToast("Couldn't save building"),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteBuilding(id!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["buildings"] }); navigate("/buildings"); },
    onError: errorToast("Couldn't delete building"),
  });

  const createRoomMut = useMutation({
    mutationFn: createRoom,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rooms"] }); setAddRoomOpen(false); },
    onError: errorToast("Couldn't create room"),
  });

  const { register: regBldg, handleSubmit: hsBldg, reset: resetBldg, formState: { errors: errBldg } } =
    useForm<BuildingInput>({
      resolver: zodResolver(buildingSchema),
      defaultValues: building ? { name: building.name, campus_id: building.campus_id, description: building.description } : undefined,
    });

  // `resetBldg` is react-hook-form's reset function: its identity is stable for the lifetime
  // of this useForm() call, so omitting it from the deps array below is safe (this file is
  // exempted from react/exhaustive-deps in .oxlintrc.json for that reason).
  useEffect(() => {
    if (building) resetBldg({ name: building.name, campus_id: building.campus_id, description: building.description });
  }, [building]);

  const { register: regRoom, handleSubmit: hsRoom, formState: { errors: errRoom } } =
    useForm<RoomInput>({
      resolver: zodResolver(roomSchema),
      defaultValues: { building_id: id },
    });

  if (isLoading) return <PageSpinner />;
  if (!building) return <p className="text-sm text-gray-500">Building not found.</p>;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <HierarchyBreadcrumb crumbs={[
          { label: "Campuses", to: "/campuses" },
          campus ? { label: campus.name, to: `/campuses/${campus.id}` } : { label: "…" },
          { label: building.name },
        ]} />
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-xl font-semibold text-gray-900">{building.name}</h1>
          {user?.is_superuser && (
            <div className="flex items-center gap-2">
              <button onClick={() => setEditOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
              <ConfirmDialog
                trigger={<button className="flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /> Delete</button>}
                title="Delete building"
                description={`Delete "${building.name}"? All rooms and devices within will be permanently removed.`}
                confirmLabel="Delete" destructive
                onConfirm={() => deleteMut.mutate()}
              />
            </div>
          )}
        </div>
        {building.description && <p className="text-sm text-gray-500">{building.description}</p>}
        <p className="text-xs text-gray-400">Created {formatDate(building.created_at)}</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-900">Rooms ({buildingRooms.length})</h2>
          {user?.is_superuser && (
            <button onClick={() => setAddRoomOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
              <Plus className="h-3.5 w-3.5" /> Add Room
            </button>
          )}
        </div>

        {roomsLoading ? <PageSpinner /> : roomsError ? (
          <ErrorState message="Couldn't load rooms." onRetry={() => refetchRooms()} />
        ) : buildingRooms.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-300 py-12 text-gray-400">
            <Monitor className="h-8 w-8" />
            <p className="text-sm">No rooms yet</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {buildingRooms.map((r: Room) => (
              <Link key={r.id} to={`/rooms/${r.id}`} className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4 shadow-sm hover:border-blue-300 hover:shadow-md transition-all">
                <div>
                  <p className="font-medium text-gray-900">{r.name}</p>
                  {r.description && <p className="text-xs text-gray-400 mt-0.5">{r.description}</p>}
                </div>
                <ChevronRight className="h-4 w-4 text-gray-400" />
              </Link>
            ))}
          </div>
        )}
      </div>

      <SlideOver open={editOpen} onOpenChange={setEditOpen} title="Edit Building">
        <form onSubmit={hsBldg((d) => updateMut.mutate(d))} className="space-y-4">
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
          <button type="submit" disabled={updateMut.isPending} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {updateMut.isPending ? "Saving…" : "Save"}
          </button>
        </form>
      </SlideOver>

      <SlideOver open={addRoomOpen} onOpenChange={setAddRoomOpen} title="Add Room">
        <form onSubmit={hsRoom((d) => createRoomMut.mutate(d))} className="space-y-4">
          <input type="hidden" {...regRoom("building_id")} />
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Name *</label>
            <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...regRoom("name")} />
            {errRoom.name && <p className="text-xs text-red-600">{errRoom.name.message}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Description</label>
            <textarea rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 resize-none" {...regRoom("description")} />
          </div>
          <button type="submit" disabled={createRoomMut.isPending} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {createRoomMut.isPending ? "Creating…" : "Create Room"}
          </button>
        </form>
      </SlideOver>
    </div>
  );
}
