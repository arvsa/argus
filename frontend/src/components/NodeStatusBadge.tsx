// Distinct from StatusBadge's binary up/down dot -- a Node maps to a
// subtree of devices, so it always renders an aggregate count, never a
// single state.
export function NodeStatusBadge({ up, down }: { up: number | undefined; down: number | undefined }) {
  if (up === undefined || down === undefined) {
    return <span className="text-xs text-gray-300">…</span>;
  }

  return (
    <span className="flex items-center gap-1.5 text-xs font-medium">
      <span className="text-green-600">{up} up</span>
      <span className="text-gray-300">/</span>
      <span className="text-red-600">{down} down</span>
    </span>
  );
}
