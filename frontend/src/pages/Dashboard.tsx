import { Activity, AlertTriangle, CheckCircle, Monitor } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getState } from "@/api/devices";
import { useWsStore } from "@/store/ws";
import { StatCard } from "@/components/StatCard";
import { LiveFeed } from "@/components/LiveFeed";
import { StatusBadge } from "@/components/StatusBadge";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { formatTimestamp } from "@/lib/utils";

export function Dashboard() {
  const deviceStates = useWsStore((s) => s.deviceStates);

  const { data: stateData, isLoading } = useQuery({
    queryKey: ["state"],
    queryFn: () => getState(1, 1000),
    refetchInterval: 30000,
  });

  const wsItems = Object.values(deviceStates);
  const liveUp = wsItems.filter((d) => d.state === "up").length;
  const liveDown = wsItems.filter((d) => d.state === "down").length;

  const totalFromApi = stateData?.total ?? 0;
  const downDevices = (stateData?.items ?? []).filter((d) => {
    const live = deviceStates[d.addr];
    return (live?.state ?? d.state) === "down";
  });

  const upPct = totalFromApi > 0
    ? Math.round(((totalFromApi - downDevices.length) / totalFromApi) * 100)
    : null;

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
          <StatCard
            label="Total Devices"
            value={totalFromApi}
            icon={Monitor}
            color="blue"
          />
          <StatCard
            label="Devices UP"
            value={liveUp || (totalFromApi - downDevices.length)}
            icon={CheckCircle}
            color="green"
          />
          <StatCard
            label="Devices DOWN"
            value={liveDown || downDevices.length}
            icon={AlertTriangle}
            color="red"
          />
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
            {downDevices.length > 0 && (
              <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                {downDevices.length}
              </span>
            )}
          </h2>
          {downDevices.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-gray-400">
              All devices are up ✓
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto divide-y divide-gray-100">
              {downDevices.map((d) => (
                <div key={d.addr} className="flex items-center justify-between py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <StatusBadge status="down" />
                    <span className="font-mono text-gray-800">{d.addr}</span>
                    {d.hostname && <span className="text-gray-400 hidden sm:block">({d.hostname})</span>}
                  </div>
                  <span className="text-xs text-gray-400">{formatTimestamp(d.ts)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
