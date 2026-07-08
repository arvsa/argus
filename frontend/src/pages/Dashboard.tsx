import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import { getStats } from "@/api/stats";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { LiveFeedPanel } from "@/components/LiveFeedPanel";

const STATS_POLL_INTERVAL_MS = 10_000;

export function Dashboard() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    refetchInterval: STATS_POLL_INTERVAL_MS,
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Live overview across all monitored devices" />

      {isLoading && <PageSpinner />}
      {isError && <ErrorState message="Couldn't load stats." onRetry={() => refetch()} />}

      {data && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Total devices" value={data.total} icon={Activity} tone="neutral" />
          <StatCard label="Up" value={data.up} icon={ArrowUpCircle} tone="success" />
          <StatCard label="Down" value={data.down} icon={ArrowDownCircle} tone="danger" />
        </div>
      )}

      <LiveFeedPanel />
    </div>
  );
}
