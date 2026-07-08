import { AlertCircle, RefreshCw } from "lucide-react";

interface Props {
  message?: string;
  onRetry?: () => void;
}

/**
 * Renders in place of a list/table when its query failed, so a failed
 * fetch is never visually indistinguishable from "there's nothing here".
 */
export function ErrorState({ message = "Couldn't load this data.", onRetry }: Props) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-red-200 bg-red-50 py-12 text-red-700">
      <AlertCircle className="h-8 w-8" />
      <p className="text-sm font-medium">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      )}
    </div>
  );
}
