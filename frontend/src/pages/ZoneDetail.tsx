import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { isAxiosError } from "axios";
import { Inbox, KeyRound, Pencil, Trash2 } from "lucide-react";
import {
  deleteZone,
  getLatestZoneSnapshot,
  getZoneSigningKey,
  getZoneSummaries,
  registerZoneSigningKey,
  updateZoneDisplayName,
} from "@/api/zones";
import { PageHeader } from "@/components/PageHeader";
import { PageSpinner } from "@/components/Spinner";
import { ErrorState } from "@/components/ErrorState";
import { StatusBadge } from "@/components/StatusBadge";
import { NodeStatusBadge } from "@/components/NodeStatusBadge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuthStore } from "@/store/auth";
import { useApiErrorToast } from "@/hooks/useErrorToast";
import { cn } from "@/lib/utils";

function is404(err: unknown): boolean {
  return isAxiosError(err) && err.response?.status === 404;
}

function formatTs(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

// Snapshots from a real zone carry thousands of devices; rendering them
// all makes the page unusable, so render at most this many and tell the
// operator to filter.
const DEVICE_RENDER_CAP = 200;

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;

function SignatureBadge({ verified }: { verified: boolean | null }) {
  const config =
    verified === true
      ? { label: "Signature verified", cls: "bg-green-50 text-green-700" }
      : verified === false
        ? { label: "Signature INVALID", cls: "bg-red-50 text-red-700" }
        : { label: "No signing key registered", cls: "bg-gray-100 text-gray-600" };
  return (
    // testid: SigningKeyPanel's own "no key registered" copy overlaps this
    // badge's text ("no signing key registered" is a substring of both),
    // so a plain text query can't reliably target this one specifically.
    <span
      data-testid="signature-badge"
      className={cn("rounded-full px-2 py-0.5 text-xs font-medium", config.cls)}
    >
      {config.label}
    </span>
  );
}

// Superuser-only inline rename for the operator-set zone display name
// (PATCH /zones/{tenant_id}/{zone_id}).
function DisplayNameEditor({
  tenantId,
  zoneId,
  currentName,
}: {
  tenantId: string;
  zoneId: string;
  currentName: string | null;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  const mutation = useMutation({
    mutationFn: (displayName: string | null) =>
      updateZoneDisplayName(tenantId, zoneId, displayName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["zones"] });
      setEditing(false);
    },
  });

  if (!editing) {
    return (
      <button
        aria-label="Edit display name"
        title="Edit display name"
        onClick={() => {
          setName(currentName ?? "");
          setEditing(true);
        }}
        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
      >
        <Pencil className="h-4 w-4" />
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(name.trim() || null);
      }}
    >
      <input
        aria-label="Display name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Display name"
        maxLength={255}
        autoFocus
        className="rounded-lg border border-gray-300 px-2.5 py-1 text-sm focus:border-blue-500 focus:outline-none"
      />
      <button
        type="submit"
        disabled={mutation.isPending}
        className="rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="rounded-lg px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
      >
        Cancel
      </button>
      {mutation.isError && (
        <span className="text-xs text-red-600">Couldn't save the name.</span>
      )}
    </form>
  );
}

// Permanently removes the zone (summary, every snapshot, its signing
// key -- see backend crud.delete_zone) and returns to the zones list.
// Superuser-only, same gating as rename/signing-key registration above.
function DeleteZoneButton({ tenantId, zoneId }: { tenantId: string; zoneId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorToast = useApiErrorToast();

  const mutation = useMutation({
    mutationFn: () => deleteZone(tenantId, zoneId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["zones"] });
      navigate("/zones");
    },
    onError: errorToast("Couldn't delete zone"),
  });

  return (
    <ConfirmDialog
      trigger={
        <button
          aria-label="Delete zone"
          title="Delete zone"
          className="flex items-center gap-1.5 rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      }
      title={`Delete "${zoneId}"?`}
      description="This permanently removes its summary, every snapshot it ever pushed, and its registered signing key. This cannot be undone."
      confirmLabel="Delete"
      destructive
      onConfirm={() => mutation.mutate()}
    />
  );
}

// Shows the zone's registered Ed25519 verification key and, for
// superusers, a register/rotate form (PUT .../signing-key). This is the
// out-of-band registration step the ingestion pipeline's signature
// verification depends on -- the server never trusts a manifest's own
// embedded key.
function SigningKeyPanel({ tenantId, zoneId }: { tenantId: string; zoneId: string }) {
  const isSuperuser = useAuthStore((s) => s.user?.is_superuser ?? false);
  const queryClient = useQueryClient();
  const [keyHex, setKeyHex] = useState("");

  const { data: registered, isError, error } = useQuery({
    queryKey: ["zone-signing-key", tenantId, zoneId],
    queryFn: () => getZoneSigningKey(tenantId, zoneId),
    // 404 = no key registered yet, an expected state.
    retry: false,
  });
  const unregistered = isError && is404(error);

  const mutation = useMutation({
    mutationFn: (hex: string) => registerZoneSigningKey(tenantId, zoneId, hex),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["zone-signing-key", tenantId, zoneId] });
      setKeyHex("");
    },
  });

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500">
        <KeyRound className="h-3.5 w-3.5" /> Signing key
      </h2>

      <div className="mt-3 space-y-3 text-sm">
        {registered && (
          <div>
            <p className="break-all font-mono text-xs text-gray-700">
              {registered.public_key_hex}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Registered{" "}
              {registered.created_at
                ? new Date(registered.created_at).toLocaleString()
                : "—"}
              . Snapshot manifests from this zone are verified against this key.
            </p>
          </div>
        )}
        {unregistered && (
          <p className="text-gray-500">
            No signing key registered — snapshots from this zone are ingested without
            signature verification.
          </p>
        )}

        {isSuperuser && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate(keyHex.trim());
            }}
          >
            <input
              aria-label="Public key (hex)"
              value={keyHex}
              onChange={(e) => setKeyHex(e.target.value)}
              placeholder="Ed25519 public key, 64 hex chars (from the zone's signing.key.pub)"
              className="w-full max-w-xl rounded-lg border border-gray-300 px-2.5 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!HEX_KEY_RE.test(keyHex.trim()) || mutation.isPending}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {registered ? "Rotate key" : "Register key"}
            </button>
            {mutation.isError && (
              <span className="text-xs text-red-600">
                Registration failed — is the key 64 hex characters?
              </span>
            )}
          </form>
        )}
      </div>
    </section>
  );
}

// Per-zone drill-down behind a row on the Zones page: renders the zone's
// latest ingested snapshot. The node ids/addresses are whatever that
// zone's pingsvc target file declared -- opaque strings, deliberately not
// resolved against this server's own Node table (plan §4.5).
export function ZoneDetailPage() {
  const { tenantId, zoneId } = useParams<{ tenantId: string; zoneId: string }>();
  const isSuperuser = useAuthStore((s) => s.user?.is_superuser ?? false);
  const [deviceFilter, setDeviceFilter] = useState("");

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["zone-snapshot", tenantId, zoneId],
    queryFn: () => getLatestZoneSnapshot(tenantId!, zoneId!),
    enabled: Boolean(tenantId && zoneId),
    // 404 is an expected state (zone hasn't pushed yet), and transient
    // failures have the ErrorState's manual Retry -- don't auto-retry.
    retry: false,
  });

  // Reuses the summaries query (already cached from the Zones list) for
  // the operator-set display name and staleness.
  const { data: summaries } = useQuery({
    queryKey: ["zones"],
    queryFn: getZoneSummaries,
  });
  const summary = summaries?.data.find(
    (z) => z.tenant_id === tenantId && z.zone_id === zoneId
  );

  // Down devices first (they're what an operator opens this page for),
  // then by address.
  const devices = useMemo(
    () =>
      Object.entries(data?.devices_json ?? {}).sort(
        ([aAddr, a], [bAddr, b]) =>
          Number(a.ok) - Number(b.ok) || aAddr.localeCompare(bAddr)
      ),
    [data]
  );
  const filteredDevices = deviceFilter
    ? devices.filter(([addr]) => addr.includes(deviceFilter.trim()))
    : devices;
  const renderedDevices = filteredDevices.slice(0, DEVICE_RENDER_CAP);

  const nodes = Object.entries(data?.nodes_json ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <PageHeader
          title={summary?.display_name ?? zoneId ?? "Zone"}
          description={`Latest snapshot from ${tenantId}/${zoneId}`}
        />
        {isSuperuser && tenantId && zoneId && (
          <DisplayNameEditor
            tenantId={tenantId}
            zoneId={zoneId}
            currentName={summary?.display_name ?? null}
          />
        )}
        {isSuperuser && tenantId && zoneId && (
          <DeleteZoneButton tenantId={tenantId} zoneId={zoneId} />
        )}
      </div>

      {isLoading && <PageSpinner />}

      {isError && is404(error) && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-gray-200 bg-white py-16 text-gray-500">
          <Inbox className="h-8 w-8 text-gray-300" />
          <p className="text-sm font-medium text-gray-700">
            No snapshots ingested for this zone yet
          </p>
          <p className="max-w-sm text-center text-sm text-gray-500">
            The zone's argus-client hasn't pushed anything this server has pulled. Check the
            client's exporter and the ingestion logs.
          </p>
        </div>
      )}
      {isError && !is404(error) && (
        <ErrorState message="Couldn't load the zone snapshot." onRetry={() => refetch()} />
      )}

      {/* Independent of whether a snapshot has ever been pulled (data
          above) -- an operator using Add Zone to reach this page ahead
          of the zone's first push still needs to pre-register its
          signing key, not just after ingestion has already started. */}
      {tenantId && zoneId && <SigningKeyPanel tenantId={tenantId} zoneId={zoneId} />}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
            <SignatureBadge verified={data.signature_verified} />
            {summary && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  summary.is_stale ? "bg-yellow-50 text-yellow-700" : "bg-green-50 text-green-700"
                )}
              >
                {summary.is_stale ? "Stale" : "Fresh"}
              </span>
            )}
            <span>Snapshot time: {formatTs(data.snapshot_ts)}</span>
            <span className="text-gray-400">
              Pulled: {data.pulled_at ? new Date(data.pulled_at).toLocaleString() : "—"}
            </span>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-4 py-2.5">
                <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  Devices ({filteredDevices.length})
                </h2>
                <input
                  value={deviceFilter}
                  onChange={(e) => setDeviceFilter(e.target.value)}
                  placeholder="Filter by address…"
                  className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="overflow-x-auto">
                <table aria-label="Devices" className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {renderedDevices.map(([addr, state]) => (
                      <tr key={addr}>
                        <td className="px-4 py-2.5 font-mono text-gray-700">{addr}</td>
                        <td className="px-4 py-2.5">
                          <StatusBadge up={state.ok} />
                        </td>
                        <td className="px-4 py-2.5 text-gray-500">{formatTs(state.ts)}</td>
                      </tr>
                    ))}
                    {devices.length === 0 && (
                      <tr>
                        <td className="px-4 py-6 text-center text-gray-400">
                          No device states in this snapshot
                        </td>
                      </tr>
                    )}
                    {devices.length > 0 && filteredDevices.length === 0 && (
                      <tr>
                        <td className="px-4 py-6 text-center text-gray-400">
                          No devices match the filter
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {filteredDevices.length > DEVICE_RENDER_CAP && (
                <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
                  Showing {DEVICE_RENDER_CAP} of {filteredDevices.length} devices — use
                  the filter to narrow down.
                </p>
              )}
            </section>

            <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              <h2 className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-gray-500">
                Node rollups ({nodes.length})
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {nodes.map(([nodeId, counts]) => (
                      <tr key={nodeId}>
                        <td className="px-4 py-2.5 font-mono text-gray-700">{nodeId}</td>
                        <td className="px-4 py-2.5">
                          <NodeStatusBadge up={counts.up} down={counts.down} />
                        </td>
                      </tr>
                    ))}
                    {nodes.length === 0 && (
                      <tr>
                        <td className="px-4 py-6 text-center text-gray-400">
                          No node rollups in this snapshot (targets have no ancestor chains)
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
