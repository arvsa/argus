import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pencil, Trash2, Download, RefreshCw } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getRoom, getRoomStates, updateRoom, deleteRoom } from "@/api/rooms";
import { getBuilding } from "@/api/buildings";
import { getCampus } from "@/api/campuses";
import { useWsStore } from "@/store/ws";
import { useAuthStore } from "@/store/auth";
import { roomSchema, type RoomInput } from "@/lib/schemas";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { HierarchyBreadcrumb } from "@/components/HierarchyBreadcrumb";
import { StatusBadge } from "@/components/StatusBadge";
import { PageSpinner } from "@/components/Spinner";
import { useExport } from "@/hooks/useExport";
import { formatDate, formatTimestamp } from "@/lib/utils";

export function RoomDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const { exportCsv } = useExport();
  const deviceStates = useWsStore((s) => s.deviceStates);

  const { data: room, isLoading } = useQuery({
    queryKey: ["room", id],
    queryFn: () => getRoom(id!),
    enabled: !!id,
  });

  const { data: building } = useQuery({
    queryKey: ["building", room?.building_id],
    queryFn: () => getBuilding(room!.building_id),
    enabled: !!room?.building_id,
  });

  const { data: campus } = useQuery({
    queryKey: ["campus", building?.campus_id],
    queryFn: () => getCampus(building!.campus_id),
    enabled: !!building?.campus_id,
  });

  const { data: states, isLoading: statesLoading, refetch } = useQuery({
    queryKey: ["room-states", id],
    queryFn: () => getRoomStates(id!),
    enabled: !!id,
    refetchInterval: 30000,
  });

  const devices = (states ?? []).map((d) => {
    const live = deviceStates[d.addr];
    const ok = live?.ok ?? d.ok;
    return { ...d, ok };
  });

  const updateMut = useMutation({
    mutationFn: (d: RoomInput) => updateRoom(id!, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["room", id] }); setEditOpen(false); },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteRoom(id!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rooms"] }); navigate("/rooms"); },
  });

  const { register, handleSubmit, formState: { errors } } = useForm<RoomInput>({
    resolver: zodResolver(roomSchema),
    defaultValues: room ? { name: room.name, building_id: room.building_id, description: room.description } : undefined,
  });

  if (isLoading) return <PageSpinner />;
  if (!room) return <p className="text-sm text-gray-500">Room not found.</p>;

  const upCount = devices.filter((d) => d.ok).length;
  const downCount = devices.filter((d) => !d.ok).length;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <HierarchyBreadcrumb crumbs={[
          { label: "Campuses", to: "/campuses" },
          campus ? { label: campus.name, to: `/campuses/${campus.id}` } : { label: "…" },
          building ? { label: building.name, to: `/buildings/${building.id}` } : { label: "…" },
          { label: room.name },
        ]} />
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-xl font-semibold text-gray-900">{room.name}</h1>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => refetch()}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            <button
              onClick={() => exportCsv(devices, `room-${room.name}-devices.csv`)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </button>
            {user?.is_superuser && (
              <>
                <button onClick={() => setEditOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <ConfirmDialog
                  trigger={<button className="flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /> Delete</button>}
                  title="Delete room"
                  description={`Delete "${room.name}"?`}
                  confirmLabel="Delete" destructive
                  onConfirm={() => deleteMut.mutate()}
                />
              </>
            )}
          </div>
        </div>
        {room.description && <p className="text-sm text-gray-500">{room.description}</p>}
        <p className="text-xs text-gray-400">Created {formatDate(room.created_at)}</p>
      </div>

      <div className="flex gap-3">
        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
          {upCount} UP
        </span>
        <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20">
          {downCount} DOWN
        </span>
        <span className="rounded-full bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600 ring-1 ring-inset ring-gray-500/20">
          {devices.length} Total
        </span>
      </div>

      {statesLoading ? <PageSpinner /> : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">IP Address</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden sm:table-cell">Hostname</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden md:table-cell">Last Seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {devices.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-400">No devices in this room</td>
                </tr>
              ) : devices.map((d) => (
                <tr key={d.addr} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-gray-800">{d.addr}</td>
                  <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{d.hostname ?? "—"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={d.ok ? "up" : "down"} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400 hidden md:table-cell">{d.ts ? formatTimestamp(d.ts) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SlideOver open={editOpen} onOpenChange={setEditOpen} title="Edit Room">
        <form onSubmit={handleSubmit((d) => updateMut.mutate(d))} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Name *</label>
            <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...register("name")} />
            {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Description</label>
            <textarea rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 resize-none" {...register("description")} />
          </div>
          <button type="submit" disabled={updateMut.isPending} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {updateMut.isPending ? "Saving…" : "Save"}
          </button>
        </form>
      </SlideOver>
    </div>
  );
}
