import { Globe2 } from "lucide-react";

// Dedicated "not configured" state -- GET /zones/summary returning an empty
// list (not a 4xx/5xx) always means this deployment simply isn't tracking
// multiple zones, never an error or a permanently-loading tree. See
// plan/frontend-v2.md Phase 4a.
export function ZoneEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-gray-200 bg-white py-16 text-gray-500">
      <Globe2 className="h-8 w-8 text-gray-300" />
      <p className="text-sm font-medium text-gray-700">Zone tracking is not configured for this deployment</p>
      <p className="max-w-sm text-center text-sm text-gray-500">
        This is a single-zone stack, or no remote zones have pushed a snapshot yet. See development.md for the
        multi-zone argus-client / argus-server walkthrough.
      </p>
    </div>
  );
}
