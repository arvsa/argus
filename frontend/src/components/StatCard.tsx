import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface Props {
  label: string;
  value: number | string;
  icon: LucideIcon;
  color?: "blue" | "green" | "red" | "gray";
  sub?: string;
}

const colorMap = {
  blue: "text-blue-600 bg-blue-50",
  green: "text-emerald-600 bg-emerald-50",
  red: "text-red-600 bg-red-50",
  gray: "text-gray-600 bg-gray-100",
};

export function StatCard({ label, value, icon: Icon, color = "blue", sub }: Props) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{label}</p>
          <p className="mt-1 text-3xl font-semibold text-gray-900">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
        </div>
        <span className={cn("rounded-lg p-2.5", colorMap[color])}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
    </div>
  );
}
