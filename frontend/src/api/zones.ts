import client from "./client";

export interface ZoneSummary {
  id: string;
  tenant_id: string;
  zone_id: string;
  up_count: number;
  down_count: number;
  last_snapshot_ts: number | null;
  last_pulled_at: string | null;
  display_name: string | null;
  is_stale: boolean;
}

export interface ZoneSummariesPublic {
  data: ZoneSummary[];
  count: number;
}

// The latest ingested snapshot for one zone, exactly as its pingsvc
// exporter pushed it: nodes_json is per-ancestor-node up/down rollups,
// devices_json is per-address last known state. Opaque per-zone data --
// the server never unifies taxonomy across zones.
export interface ClientSnapshot {
  id: string;
  tenant_id: string;
  zone_id: string;
  snapshot_ts: number;
  storage_key: string;
  nodes_json: Record<string, { up: number; down: number }>;
  devices_json: Record<string, { ok: boolean; ts: number }>;
  signature_verified: boolean | null;
  pulled_at: string | null;
}

export const getZoneSummaries = async () => {
  const res = await client.get<ZoneSummariesPublic>("/zones/summary");
  return res.data;
};

export const getLatestZoneSnapshot = async (tenantId: string, zoneId: string) => {
  const res = await client.get<ClientSnapshot>(
    `/zones/${encodeURIComponent(tenantId)}/${encodeURIComponent(zoneId)}/latest`
  );
  return res.data;
};

export const updateZoneDisplayName = async (
  tenantId: string,
  zoneId: string,
  displayName: string | null
) => {
  const res = await client.patch<ZoneSummary>(
    `/zones/${encodeURIComponent(tenantId)}/${encodeURIComponent(zoneId)}`,
    { display_name: displayName }
  );
  return res.data;
};

// The Ed25519 public key argus-server verifies this zone's snapshot
// manifests against. Registered out-of-band by an operator -- never taken
// from a manifest itself (see backend ingestion.verify_manifest).
export interface ZoneSigningKey {
  id: string;
  tenant_id: string;
  zone_id: string;
  public_key_hex: string;
  created_at: string | null;
}

export const getZoneSigningKey = async (tenantId: string, zoneId: string) => {
  const res = await client.get<ZoneSigningKey>(
    `/zones/${encodeURIComponent(tenantId)}/${encodeURIComponent(zoneId)}/signing-key`
  );
  return res.data;
};

export const registerZoneSigningKey = async (
  tenantId: string,
  zoneId: string,
  publicKeyHex: string
) => {
  const res = await client.put<ZoneSigningKey>(
    `/zones/${encodeURIComponent(tenantId)}/${encodeURIComponent(zoneId)}/signing-key`,
    { public_key_hex: publicKeyHex }
  );
  return res.data;
};
