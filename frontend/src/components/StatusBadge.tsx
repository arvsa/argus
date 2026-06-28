import { cn } from "@/lib/utils";

type Status = "up" | "down" | "unknown";

interface Props {
  status: Status;
  className?: string;
}

const config: Record<Status, { dot: string; text: string; label: string }> = {
  up: { dot: "bg-emerald-500", text: "text-emerald-700 bg-emerald-50 ring-emerald-600/20", label: "UP" },
  down: { dot: "bg-red-500", text: "text-red-700 bg-red-50 ring-red-600/20", label: "DOWN" },
  unknown: { dot: "bg-gray-400", text: "text-gray-600 bg-gray-50 ring-gray-500/20", label: "UNKNOWN" },
};

export function StatusBadge({ status, className }: Props) {
  const c = config[status] ?? config.unknown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        c.text,
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", c.dot)} />
      {c.label}
    </span>
  );
}
