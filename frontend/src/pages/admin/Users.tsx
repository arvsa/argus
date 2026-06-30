import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, CheckCircle, XCircle, Shield } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getUsers, createUser, updateUser, deleteUser } from "@/api/users";
import type { User } from "@/store/auth";
import { registerSchema, type RegisterInput } from "@/lib/schemas";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { useApiErrorToast } from "@/hooks/useErrorToast";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

const admissionColors = {
  pending: "text-amber-700 bg-amber-50 ring-amber-600/20",
  approved: "text-emerald-700 bg-emerald-50 ring-emerald-600/20",
  rejected: "text-red-700 bg-red-50 ring-red-600/20",
};

export function AdminUsers() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const errorToast = useApiErrorToast();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["users"],
    queryFn: () => getUsers(),
  });

  const createMut = useMutation({
    mutationFn: createUser,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); setCreateOpen(false); },
    onError: errorToast("Couldn't create user"),
  });

  const approveMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      updateUser(id, { admission_status: status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
    onError: errorToast("Couldn't update user status"),
  });

  const deleteMut = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
    onError: errorToast("Couldn't delete user"),
  });

  const { register, handleSubmit, formState: { errors, isSubmitting }, reset } =
    useForm<RegisterInput>({ resolver: zodResolver(registerSchema) });

  const pendingCount = (data?.data ?? []).filter((u) => u.admission_status === "pending").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Users"
        description={`${data?.count ?? 0} user${data?.count !== 1 ? "s" : ""}${pendingCount > 0 ? ` · ${pendingCount} pending approval` : ""}`}
        action={
          <button onClick={() => setCreateOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" /> New User
          </button>
        }
      />

      {pendingCount > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {pendingCount} user{pendingCount !== 1 ? "s" : ""} waiting for approval
        </div>
      )}

      {isLoading ? <PageSpinner /> : isError ? (
        <ErrorState message="Couldn't load users." onRetry={() => refetch()} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">User</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden sm:table-cell">Role</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hidden md:table-cell">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data?.data ?? []).map((u: User) => (
                <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">
                        {u.full_name?.[0]?.toUpperCase() ?? u.email[0].toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{u.full_name ?? "—"}</p>
                        <p className="text-xs text-gray-400">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    {u.is_superuser ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-700">
                        <Shield className="h-3 w-3" /> Superuser
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500">User</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset capitalize", admissionColors[u.admission_status])}>
                      {u.admission_status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 hidden md:table-cell text-xs">{formatDate(u.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {u.admission_status === "pending" && (
                        <>
                          <button
                            onClick={() => approveMut.mutate({ id: u.id, status: "approved" })}
                            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                            title="Approve"
                          >
                            <CheckCircle className="h-3.5 w-3.5" /> Approve
                          </button>
                          <button
                            onClick={() => approveMut.mutate({ id: u.id, status: "rejected" })}
                            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                            title="Reject"
                          >
                            <XCircle className="h-3.5 w-3.5" /> Reject
                          </button>
                        </>
                      )}
                      <ConfirmDialog
                        trigger={<button className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
                        title="Delete user"
                        description={`Delete user ${u.email}? This cannot be undone.`}
                        confirmLabel="Delete" destructive
                        onConfirm={() => deleteMut.mutate(u.id)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SlideOver open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) reset(); }} title="New User">
        <form onSubmit={handleSubmit((d) => createMut.mutate(d))} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Full name (optional)</label>
            <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...register("full_name")} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Email *</label>
            <input type="email" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...register("email")} />
            {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Password *</label>
            <input type="password" placeholder="••••••••" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...register("password")} />
            {errors.password && <p className="text-xs text-red-600">{errors.password.message}</p>}
          </div>
          <button type="submit" disabled={isSubmitting || createMut.isPending} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {createMut.isPending ? "Creating…" : "Create User"}
          </button>
        </form>
      </SlideOver>
    </div>
  );
}
