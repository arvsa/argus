import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Upload } from "lucide-react";
import {
  getDeviceAssignments,
  createDeviceAssignment,
  deleteDeviceAssignment,
  bulkImportDeviceAssignments,
  type BulkImportResponse,
} from "@/api/deviceAssignments";
import { deviceAssignmentSchema, type DeviceAssignmentInput } from "@/lib/schemas";
import { parseDeviceCsv, type ParsedCsvRow } from "@/lib/csv";
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
  const [bulkOpen, setBulkOpen] = useState(false);
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();
  const queryKey = ["device-assignments", nodeId];

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => getDeviceAssignments({ nodeId }),
  });

  const createMutation = useMutation({
    mutationFn: (d: DeviceAssignmentInput) =>
      createDeviceAssignment({
        addr: d.addr,
        node_id: nodeId,
        ...(d.hostname ? { hostname: d.hostname } : {}),
      }),
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

  const bulkImportMutation = useMutation({
    mutationFn: (rows: ParsedCsvRow[]) =>
      bulkImportDeviceAssignments(rows.map((r) => ({ ...r, node_id: nodeId }))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: errorToast("Couldn't bulk-import devices"),
  });

  return (
    <div className="space-y-2 border-t border-gray-100 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Assigned devices</h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              bulkImportMutation.reset();
              setBulkOpen(true);
            }}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <Upload className="h-3.5 w-3.5" /> Bulk import
          </button>
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
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
                <span className="min-w-0 truncate">
                  {device.hostname ? (
                    <>
                      <span className="block truncate font-medium text-gray-900">
                        {device.hostname}
                      </span>
                      <span className="block truncate font-mono text-xs text-gray-400">
                        {device.addr}
                      </span>
                    </>
                  ) : (
                    <span className="truncate font-mono text-gray-700">{device.addr}</span>
                  )}
                </span>
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

      <SlideOver open={bulkOpen} onOpenChange={setBulkOpen} title="Bulk import devices">
        <BulkImportForm
          onSubmit={(rows) => bulkImportMutation.mutate(rows)}
          isSubmitting={bulkImportMutation.isPending}
          result={bulkImportMutation.data}
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
      <div className="space-y-1">
        <label htmlFor="device-hostname" className="text-sm font-medium text-gray-700">
          Name <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="device-hostname"
          placeholder="floor-1-switch"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("hostname")}
        />
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

const OUTCOME_LABELS: Record<string, string> = {
  created: "created",
  reassigned: "reassigned",
  skipped_duplicate: "skipped (already exists)",
  error: "error",
};

function BulkImportForm({
  onSubmit,
  isSubmitting,
  result,
}: {
  onSubmit: (rows: ParsedCsvRow[]) => void;
  isSubmitting: boolean;
  result: BulkImportResponse | undefined;
}) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  function handleSubmit(e: { preventDefault: () => void }) {
    e.preventDefault();
    const { rows, errors } = parseDeviceCsv(text);
    if (errors.length > 0) {
      setParseError(errors[0].message);
      return;
    }
    setParseError(null);
    onSubmit(rows);
  }

  const counts = result?.results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="bulk-import-csv" className="text-sm font-medium text-gray-700">
          Paste CSV
        </label>
        <textarea
          id="bulk-import-csv"
          rows={8}
          placeholder={"addr,hostname\n10.0.1.1,floor-1-switch"}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="text-xs text-gray-400">
          Header row required, at minimum an "addr" column. "hostname", "mac", "timezone" are
          optional.
        </p>
        {parseError && <p className="text-xs text-red-600">{parseError}</p>}
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isSubmitting && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
        Import
      </button>

      {counts && (
        <div className="space-y-1 rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-600">
          {Object.entries(counts).map(([outcome, count]) => (
            <p key={outcome} className={outcome === "error" ? "text-red-600" : undefined}>
              {count} {OUTCOME_LABELS[outcome] ?? outcome}
            </p>
          ))}
        </div>
      )}
    </form>
  );
}
