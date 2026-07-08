import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getState } from "@/api/devices";
import { StatusBadge } from "@/components/StatusBadge";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";

const PAGE_SIZE = 50;

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function DevicesPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["state", page],
    queryFn: () => getState({ page, size: PAGE_SIZE }),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <PageHeader title="Devices" description="Live ping status for all monitored devices" />

      {isLoading && <PageSpinner />}
      {isError && <ErrorState message="Couldn't load devices." onRetry={() => refetch()} />}

      {data && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {data.items.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No devices found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5">Address</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Last seen</th>
                    <th className="px-4 py-2.5">Interval</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.items.map((item) => (
                    <tr key={item.addr}>
                      <td className="px-4 py-2.5 font-mono text-gray-800">{item.addr}</td>
                      <td className="px-4 py-2.5"><StatusBadge up={item.ok} /></td>
                      <td className="px-4 py-2.5 text-gray-500">{formatTs(item.ts)}</td>
                      <td className="px-4 py-2.5 text-gray-500">{item.interval_ms}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
            <p className="text-sm text-gray-500">
              Page {data.page} of {totalPages} ({data.total} total)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
