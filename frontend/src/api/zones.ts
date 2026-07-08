import client from "./client";

export interface ZoneSummary {
  id: string;
  tenant_id: string;
  zone_id: string;
  up_count: number;
  down_count: number;
  last_snapshot_ts: number | null;
  last_pulled_at: string | null;
  is_stale: boolean;
}

export interface ZoneSummariesPublic {
  data: ZoneSummary[];
  count: number;
}

export const getZoneSummaries = async () => {
  const res = await client.get<ZoneSummariesPublic>("/zones/summary");
  return res.data;
};
