import { useLiveFeed } from "@/hooks/useLiveFeed";

export function LiveFeedPanel() {
  const { events } = useLiveFeed();

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900">Live feed</h2>
        <span className="text-xs text-gray-400">Best-effort, unscoped firehose</span>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-gray-500">No live events yet.</p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
          {events.map((event, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 border-b border-gray-50 py-1 last:border-0"
            >
              <span className="truncate font-mono text-gray-700">{event.data?.addr ?? event.channel}</span>
              <span className={event.data?.ok ? "text-green-600" : "text-red-600"}>
                {event.data ? (event.data.ok ? "up" : "down") : "?"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
