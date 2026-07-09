import { cn } from "@/lib/utils";

type AdmissionStatus = "pending" | "approved" | "rejected";

const config: Record<AdmissionStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-yellow-50 text-yellow-700" },
  approved: { label: "Approved", className: "bg-green-50 text-green-700" },
  rejected: { label: "Rejected", className: "bg-red-50 text-red-700" },
};

export function AdmissionBadge({ status }: { status: AdmissionStatus }) {
  const { label, className } = config[status];
  return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", className)}>{label}</span>;
}
