import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { useState } from "react";
import { resetPasswordSchema, type ResetPasswordInput } from "@/lib/schemas";
import { resetPassword } from "@/api/auth";
import { Spinner } from "@/components/Spinner";

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const token = params.get("token") ?? "";

  const { register, handleSubmit, formState: { errors, isSubmitting } } =
    useForm<ResetPasswordInput>({ resolver: zodResolver(resetPasswordSchema) });

  async function onSubmit(data: ResetPasswordInput) {
    setError(null);
    try {
      await resetPassword(token, data.new_password);
      navigate("/login");
    } catch {
      setError("Invalid or expired token");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">New password</h2>
        <p className="text-sm text-gray-500">Choose a strong password</p>
      </div>
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">New password</label>
        <input type="password" placeholder="••••••••"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("new_password")} />
        {errors.new_password && <p className="text-xs text-red-600">{errors.new_password.message}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Confirm password</label>
        <input type="password" placeholder="••••••••"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("confirm_password")} />
        {errors.confirm_password && <p className="text-xs text-red-600">{errors.confirm_password.message}</p>}
      </div>
      <button type="submit" disabled={isSubmitting}
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
        {isSubmitting && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
        Reset password
      </button>
      <p className="text-center text-sm">
        <Link to="/login" className="text-blue-600 hover:underline">Back to login</Link>
      </p>
    </form>
  );
}
