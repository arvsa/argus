import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, Fingerprint } from "lucide-react";
import { getZoneIdentity } from "@/api/zoneIdentity";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";

function CopyableField({
  label,
  value,
  copyLabel = label,
}: {
  label: string;
  value: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg bg-gray-50 px-2.5 py-1.5 font-mono text-xs text-gray-800">
          {value}
        </code>
        <button
          aria-label={`Copy ${copyLabel.toLowerCase()}`}
          title={`Copy ${copyLabel.toLowerCase()}`}
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// Shown on a client (zone) deployment's Zones page in place of the
// "not configured" empty state: an operator setting up multi-zone for
// the first time has no other way to learn this zone's own connection
// info (backend has no local knowledge of it -- see
// backend/app/api/routes/utils.py:zone_identity), so surface it directly
// with copy buttons instead of requiring a shell into the pingsvc
// container.
export function ZoneIdentityCard() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["zone-identity"],
    queryFn: getZoneIdentity,
    retry: false,
  });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500">
        <Fingerprint className="h-3.5 w-3.5" /> This zone's identity
      </h2>
      <p className="mt-1 text-sm text-gray-500">
        Give this to your argus-server admin to register under Zones → this zone → Signing key.
      </p>

      {isLoading && <PageSpinner />}
      {isError && (
        <div className="mt-3">
          <ErrorState message="Couldn't load this zone's identity." onRetry={() => refetch()} />
        </div>
      )}

      {data && (
        <div className="mt-3 space-y-3">
          <CopyableField label="Zone ID" value={data.zone_id} />
          <CopyableField label="Tenant ID" value={data.tenant_id} />
          {data.public_key_hex ? (
            <CopyableField label="Signing public key" copyLabel="Public key" value={data.public_key_hex} />
          ) : (
            <p className="text-sm text-gray-500">
              No signing key yet -- it's generated the first time the exporter runs
              (ARGUS_ROLE=both/exporter with ARGUS_SIGNING_KEY_PATH set).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
