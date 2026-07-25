import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getDiscoveredDevices,
  approveDiscoveredDevice,
  rejectDiscoveredDevice,
} from "@/api/discoveredDevices";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { AdmissionBadge } from "@/components/AdmissionBadge";
import { useApiErrorToast } from "@/hooks/useErrorToast";

const DISCOVERED_KEY = ["discovered-devices"];

// Review queue for pingsvc's discovery subsystem (plan/device-discovery-
// v1.md §2.7 / plan/device-naming-and-bulk-import-v1.md §2.3) -- a
// candidate never becomes a monitored Device until approved here (or
// AUTO_POPULATE_DISCOVERED_DEVICES is on, in which case it arrives
// pre-approved).
export function DiscoveredDevicesPage() {
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: DISCOVERED_KEY,
    queryFn: getDiscoveredDevices,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveDiscoveredDevice(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DISCOVERED_KEY }),
    onError: errorToast("Couldn't approve device"),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => rejectDiscoveredDevice(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DISCOVERED_KEY }),
    onError: errorToast("Couldn't reject device"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Discovered devices"
        description="Review devices pingsvc found via SNMP infrastructure polling before they're monitored"
      />

      {isLoading && <PageSpinner />}
      {isError && (
        <ErrorState message="Couldn't load discovered devices." onRetry={() => refetch()} />
      )}

      {data && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {data.data.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No discovery candidates yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5">Address</th>
                    <th className="px-4 py-2.5">MAC</th>
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">Via</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.data.map((d) => (
                    <tr key={d.id}>
                      <td className="px-4 py-2.5 font-mono text-gray-800">{d.addr}</td>
                      <td className="px-4 py-2.5 font-mono text-gray-600">{d.mac ?? "—"}</td>
                      <td className="px-4 py-2.5 text-gray-600">{d.hostname ?? "—"}</td>
                      <td className="px-4 py-2.5 text-gray-500">{d.discovered_via}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <AdmissionBadge status={d.status} />
                          {d.is_stale && (
                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                              Stale
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => approveMutation.mutate(d.id)}
                            disabled={d.status === "approved"}
                            className="rounded px-1.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-40"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => rejectMutation.mutate(d.id)}
                            disabled={d.status === "rejected"}
                            className="rounded px-1.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
                          >
                            Reject
                          </button>
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
    </div>
  );
}
