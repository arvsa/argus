import * as Toast from "@radix-ui/react-toast";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { useToastStore } from "@/store/toast";
import { cn } from "@/lib/utils";

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <Toast.Provider swipeDirection="right" duration={6000}>
      {toasts.map((t) => (
        <Toast.Root
          key={t.id}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
          className={cn(
            "flex items-start gap-2.5 rounded-lg border p-3.5 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:fade-out-80 sm:data-[state=open]:slide-in-from-right-full",
            t.variant === "error" ? "border-red-200 bg-red-50" : "border-emerald-200 bg-emerald-50"
          )}
        >
          {t.variant === "error" ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          )}
          <div className="flex-1 min-w-0">
            <Toast.Title
              className={cn(
                "text-sm font-medium",
                t.variant === "error" ? "text-red-800" : "text-emerald-800"
              )}
            >
              {t.title}
            </Toast.Title>
            {t.description && (
              <Toast.Description
                className={cn(
                  "mt-0.5 text-xs break-words",
                  t.variant === "error" ? "text-red-600" : "text-emerald-600"
                )}
              >
                {t.description}
              </Toast.Description>
            )}
          </div>
          <Toast.Close className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </Toast.Close>
        </Toast.Root>
      ))}
      <Toast.Viewport className="fixed bottom-0 right-0 z-100 flex w-full max-w-sm flex-col gap-2 p-4 outline-none sm:bottom-4 sm:right-4" />
    </Toast.Provider>
  );
}
