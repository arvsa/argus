import { Activity, AlertTriangle, CheckCircle, Monitor } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getState, getStats } from "@/api/devices";
import { useWsStore } from "@/store/ws";
import { StatCard } from "@/components/StatCard";
import { LiveFeed } from "@/components/LiveFeed";
import { StatusBadge } from "@/components/StatusBadge";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { formatTimestamp } from "@/lib/utils";

export function Dashboard() {
  const deviceStates = useWsStore((s) => s.deviceStates);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    refetchInterval: 30000,
  });

  // Only fetch the first 100 down devices for the list panel
  const { data: downPage, isLoading: downLoading } = useQuery({
    queryKey: ["state-down"],
    queryFn: () => getState(1, 100),
    refetchInterval: 30000,
  });

  const isLoading = statsLoading || downLoading;

  // WS-derived live deltas (only devices that have had a state change since page load)
  const wsItems = Object.values(deviceStates);
  const wsUp = wsItems.filter((d) => d.ok).length;
  const wsDown = wsItems.filter((d) => !d.ok).length;

  const total = stats?.total ?? 0;
  const upCount = wsItems.length > 0 ? wsUp : (stats?.up ?? 0);
  const downCount = wsItems.length > 0 ? wsDown : (stats?.down ?? 0);
  const upPct = total > 0 ? Math.round((upCount / total) * 100) : null;

  const downDevices = (downPage?.items ?? []).filter((d) => {
    const live = deviceStates[d.addr];
    return !(live?.ok ?? d.ok);
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Real-time network monitoring overview"
      />

      {isLoading ? (
        <PageSpinner />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Total Devices" value={total} icon={Monitor} color="blue" />
          <StatCard label="Devices UP" value={upCount} icon={CheckCircle} color="green" />
          <StatCard label="Devices DOWN" value={downCount} icon={AlertTriangle} color="red" />
          <StatCard
            label="Uptime"
            value={upPct !== null ? `${upPct}%` : "—"}
            icon={Activity}
            color={upPct !== null && upPct >= 95 ? "green" : "red"}
          />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">Live Event Feed</h2>
          <div className="max-h-96 overflow-y-auto">
            <LiveFeed />
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">
            Down Devices
            {downCount > 0 && (
              <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                {downCount.toLocaleString()}
              </span>
            )}
          </h2>
          {downDevices.length === 0 && downCount === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-gray-400">
              All devices are up ✓
            </div>
          ) : (
            <>
              <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
                {downDevices.map((d) => (
                  <div key={d.addr} className="flex items-center justify-between py-2 text-sm">
                    <div className="flex items-center gap-3">
                      <StatusBadge status="down" />
                      <span className="font-mono text-gray-800">{d.addr}</span>
                      {d.hostname && (
                        <span className="text-gray-400 hidden sm:block">({d.hostname})</span>
                      )}
                    </div>
                    <span className="text-xs text-gray-400">{formatTimestamp(d.ts)}</span>
                  </div>
                ))}
              </div>
              {downCount > 100 && (
                <p className="mt-2 text-xs text-gray-400 text-center">
                  Showing 100 of {downCount.toLocaleString()} down devices
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
