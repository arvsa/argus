import { useLiveFeed } from "@/hooks/useLiveFeed";
import { cn } from "@/lib/utils";

const statusConfig = {
  connecting: { label: "Connecting…", dot: "bg-yellow-400" },
  open: { label: "Live", dot: "bg-green-500" },
  closed: { label: "Disconnected", dot: "bg-gray-400" },
  error: { label: "Connection error", dot: "bg-red-500" },
} as const;

export function WsIndicator() {
  const { status } = useLiveFeed();
  const { label, dot } = statusConfig[status];

  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
      <span className={cn("h-1.5 w-1.5 rounded-full", dot, status === "open" && "animate-pulse")} />
      {label}
    </div>
  );
}
