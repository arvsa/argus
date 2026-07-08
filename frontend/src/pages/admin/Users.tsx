import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { getUsers, createUser, updateUser, deleteUser } from "@/api/users";
import { useAuthStore } from "@/store/auth";
import type { User } from "@/store/auth";
import { createUserSchema, editUserSchema, type CreateUserInput, type EditUserInput } from "@/lib/schemas";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner, Spinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { SlideOver } from "@/components/SlideOver";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AdmissionBadge } from "@/components/AdmissionBadge";
import { PendingStatusFilter, type AdmissionFilter } from "@/components/PendingStatusFilter";
import { useApiErrorToast } from "@/hooks/useErrorToast";

const USERS_KEY = ["users"];

export function UsersPage() {
  const [filter, setFilter] = useState<AdmissionFilter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const currentUser = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: USERS_KEY,
    queryFn: getUsers,
  });

  const rows = data ? data.data.filter((u) => filter === "all" || u.admission_status === filter) : [];

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USERS_KEY });
      setAddOpen(false);
    },
    onError: errorToast("Couldn't create user"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updateUser>[1] }) => updateUser(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USERS_KEY });
      setEditing(null);
    },
    onError: errorToast("Couldn't update user"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
    onError: errorToast("Couldn't delete user"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Manage user accounts and admission status"
        action={
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add user
          </button>
        }
      />
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
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((u) => {
                    const isSelf = u.id === currentUser?.id;
                    return (
                      <tr key={u.id}>
                        <td className="px-4 py-2.5 text-gray-800">{u.email}</td>
                        <td className="px-4 py-2.5 text-gray-600">{u.full_name ?? "—"}</td>
                        <td className="px-4 py-2.5 text-gray-600">{u.is_superuser ? "Superuser" : "User"}</td>
                        <td className="px-4 py-2.5">
                          <AdmissionBadge status={u.admission_status} />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => setEditing(u)}
                              className="rounded px-1.5 py-1 text-xs font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                              aria-label={`Edit ${u.full_name ?? u.email}`}
                            >
                              Edit
                            </button>
                            {!isSelf && (
                              <ConfirmDialog
                                trigger={
                                  <button
                                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                    aria-label={`Delete ${u.full_name ?? u.email}`}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                }
                                title={`Delete "${u.email}"?`}
                                description="This cannot be undone."
                                confirmLabel="Delete"
                                destructive
                                onConfirm={() => deleteMutation.mutate(u.id)}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <SlideOver open={addOpen} onOpenChange={setAddOpen} title="Add user">
        <CreateUserForm
          onSubmit={(d) => createMutation.mutate(d)}
          isSubmitting={createMutation.isPending}
        />
      </SlideOver>

      <SlideOver open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} title="Edit user">
        {editing && (
          <EditUserForm
            user={editing}
            onSubmit={(d) => updateMutation.mutate({ id: editing.id, data: d })}
            isSubmitting={updateMutation.isPending}
          />
        )}
      </SlideOver>
    </div>
  );
}

function CreateUserForm({
  onSubmit,
  isSubmitting,
}: {
  onSubmit: (d: CreateUserInput) => void;
  isSubmitting: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { is_superuser: false },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="create-user-email" className="text-sm font-medium text-gray-700">Email</label>
        <input
          id="create-user-email"
          type="email"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("email")}
        />
        {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor="create-user-password" className="text-sm font-medium text-gray-700">Password</label>
        <input
          id="create-user-password"
          type="password"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("password")}
        />
        {errors.password && <p className="text-xs text-red-600">{errors.password.message}</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor="create-user-full-name" className="text-sm font-medium text-gray-700">Full name</label>
        <input
          id="create-user-full-name"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("full_name")}
        />
      </div>
      <div className="flex items-center gap-2">
        <input id="create-user-is-superuser" type="checkbox" {...register("is_superuser")} />
        <label htmlFor="create-user-is-superuser" className="text-sm text-gray-700">Superuser</label>
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isSubmitting && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
        Create user
      </button>
    </form>
  );
}

function EditUserForm({
  user,
  onSubmit,
  isSubmitting,
}: {
  user: User;
  onSubmit: (d: Parameters<typeof updateUser>[1]) => void;
  isSubmitting: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<EditUserInput>({
    resolver: zodResolver(editUserSchema),
    defaultValues: {
      email: user.email,
      full_name: user.full_name ?? "",
      is_superuser: user.is_superuser,
      admission_status: user.admission_status,
      password: "",
    },
  });

  function submit(d: EditUserInput) {
    const { password, ...rest } = d;
    onSubmit(password ? { ...rest, password } : rest);
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="edit-user-email" className="text-sm font-medium text-gray-700">Email</label>
        <input
          id="edit-user-email"
          type="email"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("email")}
        />
        {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor="edit-user-full-name" className="text-sm font-medium text-gray-700">Full name</label>
        <input
          id="edit-user-full-name"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("full_name")}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="edit-user-admission-status" className="text-sm font-medium text-gray-700">Admission status</label>
        <select
          id="edit-user-admission-status"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("admission_status")}
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <input id="edit-user-is-superuser" type="checkbox" {...register("is_superuser")} />
        <label htmlFor="edit-user-is-superuser" className="text-sm text-gray-700">Superuser</label>
      </div>
      <div className="space-y-1">
        <label htmlFor="edit-user-password" className="text-sm font-medium text-gray-700">New password</label>
        <input
          id="edit-user-password"
          type="password"
          placeholder="Leave blank to keep current password"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("password")}
        />
        {errors.password && <p className="text-xs text-red-600">{errors.password.message}</p>}
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isSubmitting && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
        Save
      </button>
    </form>
  );
}
