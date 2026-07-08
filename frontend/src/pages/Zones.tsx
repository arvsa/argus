import { useQuery } from "@tanstack/react-query";
import { getZoneSummaries } from "@/api/zones";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { ZoneEmptyState } from "@/components/ZoneEmptyState";
import { NodeStatusBadge } from "@/components/NodeStatusBadge";
import { cn } from "@/lib/utils";

function formatLastPulled(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "never";
}

export function ZonesPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["zones"],
    queryFn: getZoneSummaries,
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Zones" description="Remote zone health (multi-zone deployments only)" />

      {isLoading && <PageSpinner />}
      {isError && <ErrorState message="Couldn't load zones." onRetry={() => refetch()} />}

      {data && (data.data.length === 0 ? (
        <ZoneEmptyState />
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2.5">Tenant</th>
                  <th className="px-4 py-2.5">Zone</th>
                  <th className="px-4 py-2.5">Devices</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Last pulled</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.data.map((zone) => (
                  <tr key={zone.id}>
                    <td className="px-4 py-2.5 font-medium text-gray-800">{zone.tenant_id}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-700">{zone.zone_id}</td>
                    <td className="px-4 py-2.5">
                      <NodeStatusBadge up={zone.up_count} down={zone.down_count} />
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium",
                          zone.is_stale ? "bg-yellow-50 text-yellow-700" : "bg-green-50 text-green-700"
                        )}
                      >
                        {zone.is_stale ? "Stale" : "Fresh"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">{formatLastPulled(zone.last_pulled_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
