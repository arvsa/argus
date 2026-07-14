import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { getZoneSummaries } from "@/api/zones";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { ZoneEmptyState } from "@/components/ZoneEmptyState";
import { NodeStatusBadge } from "@/components/NodeStatusBadge";
import { useAuthStore } from "@/store/auth";
import { cn } from "@/lib/utils";

function formatLastPulled(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "never";
}

// Zones only otherwise appear as a side effect of ingestion (a zone's
// first pushed snapshot creates its row) -- there's no "create a zone"
// concept to back a real form. This just navigates to a zone's detail
// page ahead of its first push, so an operator can pre-register its
// signing key (ZoneDetail already renders a "no snapshot yet" empty
// state plus the signing-key panel for a zone with no ClientSnapshot).
function AddZoneForm() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [zoneId, setZoneId] = useState("");

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add zone
      </button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        navigate(`/zones/${encodeURIComponent(tenantId.trim())}/${encodeURIComponent(zoneId.trim())}`);
      }}
    >
      <input
        aria-label="Tenant ID"
        value={tenantId}
        onChange={(e) => setTenantId(e.target.value)}
        placeholder="Tenant ID"
        autoFocus
        className="w-32 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      />
      <input
        aria-label="Zone ID"
        value={zoneId}
        onChange={(e) => setZoneId(e.target.value)}
        placeholder="Zone ID"
        className="w-32 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      />
      <button
        type="submit"
        disabled={!tenantId.trim() || !zoneId.trim()}
        className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Go
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-lg px-2 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
      >
        Cancel
      </button>
    </form>
  );
}

export function ZonesPage() {
  const navigate = useNavigate();
  const isSuperuser = useAuthStore((s) => s.user?.is_superuser ?? false);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["zones"],
    queryFn: getZoneSummaries,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Zones"
        description="Remote zone health (multi-zone deployments only)"
        action={isSuperuser ? <AddZoneForm /> : undefined}
      />

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
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Tenant</th>
                  <th className="px-4 py-2.5">Zone</th>
                  <th className="px-4 py-2.5">Devices</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Last pulled</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.data.map((zone) => (
                  <tr
                    key={zone.id}
                    onClick={() => navigate(`/zones/${zone.tenant_id}/${zone.zone_id}`)}
                    className="cursor-pointer hover:bg-gray-50"
                  >
                    <td className="px-4 py-2.5 font-medium text-gray-800">
                      {zone.display_name ?? <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700">{zone.tenant_id}</td>
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
