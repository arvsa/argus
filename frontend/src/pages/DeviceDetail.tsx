import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getDevice, updateDevice, deleteDevice } from "@/api/devices";
import { getRooms } from "@/api/rooms";
import { useWsStore } from "@/store/ws";
import { useAuthStore } from "@/store/auth";
import { deviceSchema, type DeviceInput } from "@/lib/schemas";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { PageSpinner } from "@/components/Spinner";
import { formatDate, formatTimestamp } from "@/lib/utils";

export function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const deviceStates = useWsStore((s) => s.deviceStates);

  const { data: device, isLoading } = useQuery({
    queryKey: ["device", id],
    queryFn: () => getDevice(id!),
    enabled: !!id,
  });

  const { data: roomsData } = useQuery({ queryKey: ["rooms"], queryFn: () => getRooms() });
  const rooms = roomsData?.data ?? [];
  const roomName = (rid?: string) => rooms.find((r) => r.id === rid)?.name ?? "Unassigned";

  const liveState = device ? deviceStates[device.ip_address] : null;

  const updateMut = useMutation({
    mutationFn: (d: DeviceInput) => updateDevice(id!, { ip_address: d.ip_address, hostname: d.hostname, room_id: d.room_id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["device", id] }); setEditOpen(false); },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteDevice(id!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["devices"] }); navigate("/devices"); },
  });

  const { register, handleSubmit, formState: { errors } } = useForm<DeviceInput>({
    resolver: zodResolver(deviceSchema),
    defaultValues: device ? { ip_address: device.ip_address, hostname: device.hostname, room_id: device.room_id } : undefined,
  });

  if (isLoading) return <PageSpinner />;
  if (!device) return <p className="text-sm text-gray-500">Device not found.</p>;

  return (
    <div className="max-w-xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-mono text-xl font-semibold text-gray-900">{device.ip_address}</h1>
        <div className="flex items-center gap-2">
          {user?.is_superuser && (
            <>
              <button onClick={() => setEditOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
              <ConfirmDialog
                trigger={<button className="flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /> Delete</button>}
                title="Delete device"
                description={`Delete device ${device.ip_address}?`}
                confirmLabel="Delete" destructive
                onConfirm={() => deleteMut.mutate()}
              />
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Status</p>
            <div className="mt-1">
              <StatusBadge status={liveState?.state ?? "unknown"} />
            </div>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Last Seen</p>
            <p className="mt-1 text-sm text-gray-800">
              {liveState ? formatTimestamp(liveState.ts) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Hostname</p>
            <p className="mt-1 text-sm text-gray-800">{device.hostname ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Room</p>
            <p className="mt-1 text-sm text-gray-800">{roomName(device.room_id)}</p>
          </div>
          <div className="col-span-2">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Description</p>
            <p className="mt-1 text-sm text-gray-800">{device.description ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Created</p>
            <p className="mt-1 text-sm text-gray-800">{formatDate(device.created_at)}</p>
          </div>
        </div>
      </div>

      <SlideOver open={editOpen} onOpenChange={setEditOpen} title="Edit Device">
        <form onSubmit={handleSubmit((d) => updateMut.mutate(d))} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">IP Address *</label>
            <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...register("ip_address")} />
            {errors.ip_address && <p className="text-xs text-red-600">{errors.ip_address.message}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Hostname</label>
            <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...register("hostname")} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Room</label>
            <select className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 bg-white" {...register("room_id")}>
              <option value="">Unassigned</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <button type="submit" disabled={updateMut.isPending} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {updateMut.isPending ? "Saving…" : "Save"}
          </button>
        </form>
      </SlideOver>
    </div>
  );
}
