import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getUsers } from "@/api/users";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { AdmissionBadge } from "@/components/AdmissionBadge";
import { PendingStatusFilter, type AdmissionFilter } from "@/components/PendingStatusFilter";

export function UsersPage() {
  const [filter, setFilter] = useState<AdmissionFilter>("all");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["users"],
    queryFn: getUsers,
  });

  const rows = data ? data.data.filter((u) => filter === "all" || u.admission_status === filter) : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="Manage user accounts and admission status" />
      <PendingStatusFilter value={filter} onChange={setFilter} />

      {isLoading && <PageSpinner />}
      {isError && <ErrorState message="Couldn't load users." onRetry={() => refetch()} />}

      {data && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No users match this filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5">Email</th>
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">Role</th>
                    <th className="px-4 py-2.5">Admission</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((u) => (
                    <tr key={u.id}>
                      <td className="px-4 py-2.5 text-gray-800">{u.email}</td>
                      <td className="px-4 py-2.5 text-gray-600">{u.full_name ?? "—"}</td>
                      <td className="px-4 py-2.5 text-gray-600">{u.is_superuser ? "Superuser" : "User"}</td>
                      <td className="px-4 py-2.5">
                        <AdmissionBadge status={u.admission_status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
