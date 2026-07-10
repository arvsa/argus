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
