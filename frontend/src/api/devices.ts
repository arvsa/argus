import client from "./client";

// Matches pingsvc's Event struct exactly (pingsvc/cmd/pingsvc/main.go) --
// this is what's actually stored in Redis's pings:state and published on
// pings:events/events:node:<id>, not a shape defined by this frontend.
export interface DeviceState {
  addr: string;
  ok: boolean;
  ts: number;
  interval_ms: number;
  rtt_ms?: number;
  err?: string;
  node_ids?: string[];
}

export interface DeviceStatePage {
  page: number;
  size: number;
  total: number;
  items: DeviceState[];
}

export const getState = async (params: { page: number; size: number }) => {
  const res = await client.get<DeviceStatePage>("/state", { params });
  return res.data;
};
