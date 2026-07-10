import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { isAxiosError } from "axios";
import { Inbox } from "lucide-react";
import { getLatestZoneSnapshot, getZoneSummaries } from "@/api/zones";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { StatusBadge } from "@/components/StatusBadge";
import { NodeStatusBadge } from "@/components/NodeStatusBadge";
import { cn } from "@/lib/utils";

function is404(err: unknown): boolean {
  return isAxiosError(err) && err.response?.status === 404;
}

function formatTs(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

function SignatureBadge({ verified }: { verified: boolean | null }) {
  const config =
    verified === true
      ? { label: "Signature verified", cls: "bg-green-50 text-green-700" }
      : verified === false
        ? { label: "Signature INVALID", cls: "bg-red-50 text-red-700" }
        : { label: "No signing key registered", cls: "bg-gray-100 text-gray-600" };
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", config.cls)}>
      {config.label}
    </span>
  );
}

// Per-zone drill-down behind a row on the Zones page: renders the zone's
// latest ingested snapshot. The node ids/addresses are whatever that
// zone's pingsvc target file declared -- opaque strings, deliberately not
// resolved against this server's own Node table (plan §4.5).
export function ZoneDetailPage() {
  const { tenantId, zoneId } = useParams<{ tenantId: string; zoneId: string }>();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["zone-snapshot", tenantId, zoneId],
    queryFn: () => getLatestZoneSnapshot(tenantId!, zoneId!),
    enabled: Boolean(tenantId && zoneId),
    // 404 is an expected state (zone hasn't pushed yet), and transient
    // failures have the ErrorState's manual Retry -- don't auto-retry.
    retry: false,
  });

  // Reuses the summaries query (already cached from the Zones list) for
  // the operator-set display name and staleness.
  const { data: summaries } = useQuery({
    queryKey: ["zones"],
    queryFn: getZoneSummaries,
  });
  const summary = summaries?.data.find(
    (z) => z.tenant_id === tenantId && z.zone_id === zoneId
  );

  const devices = Object.entries(data?.devices_json ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const nodes = Object.entries(data?.nodes_json ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={summary?.display_name ?? zoneId ?? "Zone"}
        description={`Latest snapshot from ${tenantId}/${zoneId}`}
      />

      {isLoading && <PageSpinner />}

      {isError && is404(error) && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-gray-200 bg-white py-16 text-gray-500">
          <Inbox className="h-8 w-8 text-gray-300" />
          <p className="text-sm font-medium text-gray-700">
            No snapshots ingested for this zone yet
          </p>
          <p className="max-w-sm text-center text-sm text-gray-500">
            The zone's argus-client hasn't pushed anything this server has pulled. Check the
            client's exporter and the ingestion logs.
          </p>
        </div>
      )}
      {isError && !is404(error) && (
        <ErrorState message="Couldn't load the zone snapshot." onRetry={() => refetch()} />
      )}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
            <SignatureBadge verified={data.signature_verified} />
            {summary && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  summary.is_stale ? "bg-yellow-50 text-yellow-700" : "bg-green-50 text-green-700"
                )}
              >
                {summary.is_stale ? "Stale" : "Fresh"}
              </span>
            )}
            <span>Snapshot time: {formatTs(data.snapshot_ts)}</span>
            <span className="text-gray-400">
              Pulled: {data.pulled_at ? new Date(data.pulled_at).toLocaleString() : "—"}
            </span>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              <h2 className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-gray-500">
                Devices ({devices.length})
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {devices.map(([addr, state]) => (
                      <tr key={addr}>
                        <td className="px-4 py-2.5 font-mono text-gray-700">{addr}</td>
                        <td className="px-4 py-2.5">
                          <StatusBadge up={state.ok} />
                        </td>
                        <td className="px-4 py-2.5 text-gray-500">{formatTs(state.ts)}</td>
                      </tr>
                    ))}
                    {devices.length === 0 && (
                      <tr>
                        <td className="px-4 py-6 text-center text-gray-400">
                          No device states in this snapshot
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              <h2 className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-gray-500">
                Node rollups ({nodes.length})
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {nodes.map(([nodeId, counts]) => (
                      <tr key={nodeId}>
                        <td className="px-4 py-2.5 font-mono text-gray-700">{nodeId}</td>
                        <td className="px-4 py-2.5">
                          <NodeStatusBadge up={counts.up} down={counts.down} />
                        </td>
                      </tr>
                    ))}
                    {nodes.length === 0 && (
                      <tr>
                        <td className="px-4 py-6 text-center text-gray-400">
                          No node rollups in this snapshot (targets have no ancestor chains)
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
