import { cn } from "@/lib/utils";

export type AdmissionFilter = "all" | "pending" | "approved" | "rejected";

const options: { value: AdmissionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export function PendingStatusFilter({
  value,
  onChange,
}: {
  value: AdmissionFilter;
  onChange: (value: AdmissionFilter) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium",
              active ? "bg-blue-600 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
