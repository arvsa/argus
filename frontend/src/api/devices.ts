import client from "./client";

export interface DeviceState {
  addr: string;
  ok: boolean;
  ts: number;
  interval: number;
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
