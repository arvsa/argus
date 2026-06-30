import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { updateMe, changePassword } from "@/api/users";
import { useAuthStore } from "@/store/auth";
import { updateMeSchema, changePasswordSchema, type UpdateMeInput, type ChangePasswordInput } from "@/lib/schemas";
import { PageHeader } from "@/components/PageHeader";
import { Spinner } from "@/components/Spinner";
import { useApiErrorToast } from "@/hooks/useErrorToast";

export function Profile() {
  const { user, setUser } = useAuthStore();
  const [pwSuccess, setPwSuccess] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState(false);

  const profileForm = useForm<UpdateMeInput>({
    resolver: zodResolver(updateMeSchema),
    defaultValues: { full_name: user?.full_name ?? "", email: user?.email ?? "" },
  });

  const pwForm = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
  });

  const errorToast = useApiErrorToast();

  const profileMut = useMutation({
    mutationFn: updateMe,
    onSuccess: (u) => { setUser(u); setProfileSuccess(true); setTimeout(() => setProfileSuccess(false), 3000); },
    onError: errorToast("Couldn't update profile"),
  });

  const pwMut = useMutation({
    mutationFn: (d: ChangePasswordInput) => changePassword({ current_password: d.current_password, new_password: d.new_password }),
    onSuccess: () => { pwForm.reset(); setPwSuccess(true); setTimeout(() => setPwSuccess(false), 3000); },
    onError: errorToast("Couldn't change password"),
  });

  return (
    <div className="max-w-lg space-y-8">
      <PageHeader title="Profile" description="Manage your account settings" />

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-5">
        <h2 className="text-sm font-semibold text-gray-900">Personal Info</h2>
        <form onSubmit={profileForm.handleSubmit((d) => profileMut.mutate(d))} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Full name</label>
            <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...profileForm.register("full_name")} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Email</label>
            <input type="email" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...profileForm.register("email")} />
            {profileForm.formState.errors.email && (
              <p className="text-xs text-red-600">{profileForm.formState.errors.email.message}</p>
            )}
          </div>
          {profileSuccess && <p className="text-sm text-emerald-600">Profile updated ✓</p>}
          <button type="submit" disabled={profileMut.isPending} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {profileMut.isPending && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
            Save changes
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-5">
        <h2 className="text-sm font-semibold text-gray-900">Change Password</h2>
        <form onSubmit={pwForm.handleSubmit((d) => pwMut.mutate(d))} className="space-y-4">
          {[
            { name: "current_password" as const, label: "Current password" },
            { name: "new_password" as const, label: "New password" },
            { name: "confirm_password" as const, label: "Confirm new password" },
          ].map(({ name, label }) => (
            <div key={name} className="space-y-1">
              <label className="text-sm font-medium text-gray-700">{label}</label>
              <input type="password" placeholder="••••••••" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" {...pwForm.register(name)} />
              {pwForm.formState.errors[name] && (
                <p className="text-xs text-red-600">{pwForm.formState.errors[name]?.message}</p>
              )}
            </div>
          ))}
          {pwMut.isError && (
            <p className="text-sm text-red-600">Incorrect current password</p>
          )}
          {pwSuccess && <p className="text-sm text-emerald-600">Password updated ✓</p>}
          <button type="submit" disabled={pwMut.isPending} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {pwMut.isPending && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
            Update password
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Account</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Role</p>
            <p className="mt-1 font-medium text-gray-800">{user?.is_superuser ? "Superuser" : "User"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Status</p>
            <p className="mt-1 font-medium text-gray-800 capitalize">{user?.admission_status}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
