import { useToastStore } from "@/store/toast";
import { getErrorMessage } from "@/lib/errors";

/**
 * Returns a function that creates a mutation `onError` handler pushing a
 * toast with the API's actual error message (falls back to a generic one).
 *
 * Usage: onError: useApiErrorToast()("Couldn't delete campus")
 */
export function useApiErrorToast() {
  const push = useToastStore((s) => s.push);
  return (title: string) => (err: unknown) =>
    push({ title, description: getErrorMessage(err), variant: "error" });
}
