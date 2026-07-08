import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "react-router-dom";
import { useState } from "react";
import { registerSchema, type RegisterInput } from "@/lib/schemas";
import { register as apiRegister } from "@/api/auth";
import { getErrorMessage } from "@/lib/errors";
import { Spinner } from "@/components/Spinner";

export function Register() {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) });

  async function onSubmit(data: RegisterInput) {
    setError(null);
    try {
      await apiRegister(data);
      setDone(true);
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Registration failed"));
    }
  }

  if (done) {
    return (
      <div className="space-y-4 text-center">
        <div className="text-4xl">✅</div>
        <h2 className="text-lg font-semibold text-gray-900">Account created!</h2>
        <p className="text-sm text-gray-500">
          Your account is pending approval. You'll be notified once an admin approves it.
        </p>
        <Link
          to="/login"
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Go to login
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Create account</h2>
        <p className="text-sm text-gray-500">Request access to Argus</p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Full name (optional)</label>
        <input
          type="text"
          placeholder="Jane Doe"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("full_name")}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Email</label>
        <input
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("email")}
        />
        {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Password</label>
        <input
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          {...register("password")}
        />
        {errors.password && <p className="text-xs text-red-600">{errors.password.message}</p>}
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
      >
        {isSubmitting && <Spinner className="h-4 w-4 border-white border-t-blue-300" />}
        Create account
      </button>

      <p className="text-center text-sm text-gray-500">
        Already have an account?{" "}
        <Link to="/login" className="text-blue-600 font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
