import { useWsStore } from "@/store/ws";
import { StatusBadge } from "./StatusBadge";
import { formatTimestamp } from "@/lib/utils";

export function LiveFeed() {
  const events = useWsStore((s) => s.events);

  if (events.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-400">
        Waiting for events…
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-100">
      {events.map((ev, i) => (
        <div key={i} className="flex items-center justify-between px-1 py-2 text-sm">
          <div className="flex items-center gap-3 min-w-0">
            <StatusBadge status={ev.ok ? "up" : "down"} />
            <span className="font-mono text-gray-800 truncate">{ev.addr}</span>
            {ev.hostname && (
              <span className="text-gray-400 truncate hidden sm:block">({ev.hostname})</span>
            )}
          </div>
          <span className="ml-3 shrink-0 text-xs text-gray-400">{formatTimestamp(ev.ts)}</span>
        </div>
      ))}
    </div>
  );
}
