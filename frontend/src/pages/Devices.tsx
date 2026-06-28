import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, Upload, Download, ChevronRight, Activity } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  getDevices, createDevice, updateDevice, deleteDevice, uploadDevicesCsv, getState,
  type Device,
} from "@/api/devices";
import { getRooms } from "@/api/rooms";
import { useAuthStore } from "@/store/auth";
import { useWsStore } from "@/store/ws";
import { deviceSchema, type DeviceInput } from "@/lib/schemas";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CsvUploader } from "@/components/CsvUploader";
import { StatusBadge } from "@/components/StatusBadge";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { useExport } from "@/hooks/useExport";
import { formatDate } from "@/lib/utils";

function DeviceForm({ defaultValues, onSubmit, loading, rooms }: {
  defaultValues?: Partial<DeviceInput>;
  onSubmit: (d: DeviceInput) => void;
  loading?: boolean;
  rooms: { id: string; name: string }[];
}) {
  const { register, handleSubmit, formState: { errors } } =
    useForm<DeviceInput>({ resolver: zodResolver(deviceSchema), defaultValues });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">IP Address *</label>
        <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" placeholder="192.168.1.1" {...register("ip_address")} />
        {errors.ip_address && <p className="text-xs text-red-600">{errors.ip_address.message}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Hostname</label>
        <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" placeholder="switch-01.local" {...register("hostname")} />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Room</label>
        <select className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 bg-white" {...register("room_id")}>
          <option value="">Unassigned</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Description</label>
        <textarea rows={2} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 resize-none" {...register("description")} />
      </div>
      <button type="submit" disabled={loading} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
        {loading ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

export function Devices() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Device | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadDryRun, setUploadDryRun] = useState<{ data: unknown[]; count: number } | null>(null);
  const [page, setPage] = useState(1);
  const { exportCsv } = useExport();
  const deviceStates = useWsStore((s) => s.deviceStates);

  const { data: devicesData, isLoading } = useQuery({
    queryKey: ["devices", page],
    queryFn: () => getDevices((page - 1) * 100, 100),
  });

  const { data: stateData } = useQuery({
    queryKey: ["state", page],
    queryFn: () => getState(page, 100),
    refetchInterval: 30000,
  });

  const { data: roomsData } = useQuery({ queryKey: ["rooms"], queryFn: () => getRooms() });
  const rooms = roomsData?.data ?? [];
  const roomName = (id?: string) => rooms.find((r) => r.id === id)?.name;

  const createMut = useMutation({
    mutationFn: createDevice,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["devices"] }); setCreateOpen(false); },
  });

  const updateMut = useMutation({
    mutationFn: (d: DeviceInput) => updateDevice(editTarget!.id, { ip_address: d.ip_address, hostname: d.hostname, room_id: d.room_id, description: d.description }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["devices"] }); setEditTarget(null); },
  });

  const deleteMut = useMutation({
    mutationFn: deleteDevice,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
  });

  const uploadMut = useMutation({
    mutationFn: (file: File) => uploadDevicesCsv(file, true),
    onSuccess: (d) => setUploadDryRun(d),
  });

  const commitMut = useMutation({
    mutationFn: (file: File) => uploadDevicesCsv(file, false),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      setUploadOpen(false);
      setUploadDryRun(null);
    },
  });

  const stateItems = stateData?.items ?? [];
  const devices = devicesData?.data ?? [];
  const totalDevices = devicesData?.count ?? 0;
  const totalPages = Math.ceil(totalDevices / 100);

  function handleExport() {
    const rows = stateItems.map((d) => ({
      ip: d.addr,
      hostname: d.hostname ?? "",
      status: d.state,
      last_seen: d.ts,
    }));
    exportCsv(rows, "argus-devices.csv");
  }

  const [pendingFile, setPendingFile] = useState<File | null>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Devices"
        description={`${totalDevices} device${totalDevices !== 1 ? "s" : ""} total`}
        action={
          <div className="flex items-center gap-2">
            <button onClick={handleExport} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
              <Download className="h-4 w-4" /> Export
            </button>
            {user?.is_superuser && (
              <>
                <button onClick={() => setUploadOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <Upload className="h-4 w-4" /> Import CSV
                </button>
                <button onClick={() => setCreateOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  <Plus className="h-4 w-4" /> New Device
                </button>
              </>
            )}
          </div>
        }
      />

      {isLoading ? <PageSpinner /> : devices.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-gray-300 py-16 text-gray-400">
          <Activity className="h-10 w-10" />
          <p className="text-sm">No devices yet</p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">IP Address</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden sm:table-cell">Hostname</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden md:table-cell">Room</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden lg:table-cell">Created</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {devices.map((d) => {
                  const liveState = deviceStates[d.ip_address]?.state;
                  return (
                    <tr key={d.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-gray-800">
                        <Link to={`/devices/${d.id}`} className="hover:text-blue-600 flex items-center gap-1">
                          {d.ip_address} <ChevronRight className="h-3 w-3 text-gray-400" />
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{d.hostname ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{roomName(d.room_id) ?? "Unassigned"}</td>
                      <td className="px-4 py-3">
                        {liveState ? (
                          <StatusBadge status={liveState} />
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-400 hidden lg:table-cell">{formatDate(d.created_at)}</td>
                      <td className="px-4 py-3">
                        {user?.is_superuser && (
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => setEditTarget(d)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                              <Pencil className="h-4 w-4" />
                            </button>
                            <ConfirmDialog
                              trigger={<button className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
                              title="Delete device"
                              description={`Delete device ${d.ip_address}?`}
                              confirmLabel="Delete" destructive
                              onConfirm={() => deleteMut.mutate(d.id)}
                            />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-gray-500">
              <p>Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <button disabled={page === 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50">Previous</button>
                <button disabled={page === totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50">Next</button>
              </div>
            </div>
          )}
        </>
      )}

      <SlideOver open={createOpen} onOpenChange={setCreateOpen} title="New Device">
        <DeviceForm rooms={rooms} onSubmit={(d) => createMut.mutate(d)} loading={createMut.isPending} />
      </SlideOver>

      <SlideOver open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)} title="Edit Device">
        {editTarget && (
          <DeviceForm
            rooms={rooms}
            defaultValues={{ ip_address: editTarget.ip_address, hostname: editTarget.hostname, room_id: editTarget.room_id, description: editTarget.description }}
            onSubmit={(d) => updateMut.mutate(d)}
            loading={updateMut.isPending}
          />
        )}
      </SlideOver>

      <SlideOver open={uploadOpen} onOpenChange={(o) => { if (!o) { setUploadOpen(false); setUploadDryRun(null); setPendingFile(null); } }} title="Import Devices from CSV" description="Upload replaces all existing devices">
        <div className="space-y-4">
          {!uploadDryRun ? (
            <>
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                ⚠️ This will <strong>replace all existing devices</strong>. A dry-run preview will show before committing.
              </div>
              <CsvUploader
                onFile={(f) => { setPendingFile(f); uploadMut.mutate(f); }}
                loading={uploadMut.isPending}
              />
            </>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                ✓ Dry run successful — {uploadDryRun.count} devices will be imported.
              </div>
              <div className="flex gap-3">
                <button onClick={() => { setUploadDryRun(null); setPendingFile(null); }} className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  Cancel
                </button>
                <button
                  onClick={() => pendingFile && commitMut.mutate(pendingFile)}
                  disabled={commitMut.isPending}
                  className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {commitMut.isPending ? "Importing…" : "Confirm Import"}
                </button>
              </div>
            </div>
          )}
        </div>
      </SlideOver>
    </div>
  );
}
