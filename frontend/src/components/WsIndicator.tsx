import { useWsStore } from "@/store/ws";
import { cn } from "@/lib/utils";

export function WsIndicator() {
  const connected = useWsStore((s) => s.connected);
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-500">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          connected ? "bg-emerald-500 animate-pulse" : "bg-red-500"
        )}
      />
      <span className="hidden sm:inline">{connected ? "Live" : "Reconnecting…"}</span>
    </div>
  );
}
