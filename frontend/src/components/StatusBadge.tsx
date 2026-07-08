import { cn } from "@/lib/utils";

export function StatusBadge({ up }: { up: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        up ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", up ? "bg-green-500" : "bg-red-500")} />
      {up ? "Up" : "Down"}
    </span>
  );
}
