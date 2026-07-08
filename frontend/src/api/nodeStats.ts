import client from "./client";

export interface NodeStatEntry {
  up: number;
  down: number;
}

export type NodeStats = Record<string, NodeStatEntry>;

export const getNodeStats = async (ids: string[]) => {
  if (ids.length === 0) return {} as NodeStats;
  const res = await client.get<NodeStats>("/node-stats", { params: { ids: ids.join(",") } });
  return res.data;
};
