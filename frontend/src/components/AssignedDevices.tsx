import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import {
  getDeviceAssignments,
  createDeviceAssignment,
  deleteDeviceAssignment,
} from "@/api/deviceAssignments";
import { deviceAssignmentSchema, type DeviceAssignmentInput } from "@/lib/schemas";
import { Spinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useApiErrorToast } from "@/hooks/useErrorToast";

// Lives in the Hierarchy page's node detail panel rather than a standalone
// page -- there's already a /devices page showing live ping status from
// Redis, a different concept from this persisted address+assignment
// record (see plan/device-node-assignment-bridge-v1.md).
export function AssignedDevices({ nodeId }: { nodeId: string }) {
  const [addOpen, setAddOpen] = useState(false);
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();
  const queryKey = ["device-assignments", nodeId];

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => getDeviceAssignments({ nodeId }),
  });

  const createMutation = useMutation({
    mutationFn: (d: DeviceAssignmentInput) =>
      createDeviceAssignment({ addr: d.addr, node_id: nodeId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setAddOpen(false);
    },
    onError: errorToast("Couldn't add device"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDeviceAssignment(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: errorToast("Couldn't remove device"),
  });

  return (
    <div className="space-y-2 border-t border-gray-100 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Assigned devices</h3>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-2 text-sm text-gray-400">
          <Spinner className="h-3.5 w-3.5" /> Loading…
        </div>
      )}
      {isError && <ErrorState message="Couldn't load devices." onRetry={() => refetch()} />}

      {data &&
        (data.data.length === 0 ? (
          <p className="text-sm text-gray-500">No devices assigned to this node yet.</p>
        ) : (
          <ul className="space-y-1">
            {data.data.map((device) => (
              <li
                key={device.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-gray-100 px-3 py-1.5 text-sm"
              >
                <span className="truncate font-mono text-gray-700">{device.addr}</span>
                <ConfirmDialog
                  trigger={
                    <button
                      className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                      aria-label={`Remove ${device.addr}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  }
                  title={`Remove "${device.addr}"?`}
                  description="This deletes the device record. This cannot be undone."
                  confirmLabel="Remove"
                  destructive
                  onConfirm={() => deleteMutation.mutate(device.id)}
                />
              </li>
            ))}
          </ul>
        ))}

      <SlideOver open={addOpen} onOpenChange={setAddOpen} title="Add device">
        <AddDeviceForm
          onSubmit={(d) => createMutation.mutate(d)}
          isSubmitting={createMutation.isPending}
        />
      </SlideOver>
    </div>
  );
}

function AddDeviceForm({
  onSubmit,
  isSubmitting,
}: {
  onSubmit: (d: DeviceAssignmentInput) => void;
  isSubmitting: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<DeviceAssignmentInput>({
    resolver: zodResolver(deviceAssignmentSchema),
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="device-addr" className="text-sm font-medium text-gray-700">Address</label>
        <input
          id="device-addr"
          autoFocus
          placeholder="10.0.1.5"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("addr")}
        />
        {errors.addr && <p className="text-xs text-red-600">{errors.addr.message}</p>}
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isSubmitting && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
        Add device
      </button>
    </form>
  );
}
