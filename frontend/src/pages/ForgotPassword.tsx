import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "react-router-dom";
import { useState } from "react";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/schemas";
import { forgotPassword } from "@/api/auth";
import { Spinner } from "@/components/Spinner";

export function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const { register, handleSubmit, formState: { errors, isSubmitting } } =
    useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema) });

  async function onSubmit(data: ForgotPasswordInput) {
    await forgotPassword(data.email);
    setSent(true);
  }

  if (sent) {
    return (
      <div className="space-y-3 text-center">
        <div className="text-4xl">📬</div>
        <h2 className="text-lg font-semibold text-gray-900">Check your email</h2>
        <p className="text-sm text-gray-500">
          If that address is registered, we've sent a reset link.
        </p>
        <Link to="/login" className="text-sm text-blue-600 hover:underline">
          Back to login
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Reset password</h2>
        <p className="text-sm text-gray-500">We'll send a link to your email</p>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Email</label>
        <input
          type="email"
          placeholder="you@example.com"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("email")}
        />
        {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isSubmitting && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
        Send reset link
      </button>
      <p className="text-center text-sm">
        <Link to="/login" className="text-blue-600 hover:underline">Back to login</Link>
      </p>
    </form>
  );
}
