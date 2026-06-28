import client from "./client";

export interface Device {
  id: string;
  ip_address: string;
  hostname?: string;
  room_id?: string;
  description?: string;
  created_at: string;
}

export interface DevicesPublic {
  data: Device[];
  count: number;
}

export const getDevices = async (skip = 0, limit = 100) => {
  const res = await client.get<DevicesPublic>("/devices/", { params: { skip, limit } });
  return res.data;
};

export const getDevice = async (id: string) => {
  const res = await client.get<Device>(`/devices/${id}`);
  return res.data;
};

export const createDevice = async (data: {
  ip_address: string;
  hostname?: string;
  room_id?: string;
  description?: string;
}) => {
  const res = await client.post<Device>("/devices/", data);
  return res.data;
};

export const updateDevice = async (
  id: string,
  data: { ip_address: string; hostname?: string; room_id?: string; description?: string }
) => {
  const res = await client.put<Device>(`/devices/${id}`, data);
  return res.data;
};

export const deleteDevice = async (id: string) => {
  await client.delete(`/devices/${id}`);
};

export const uploadDevicesCsv = async (file: File, dry_run = false) => {
  const form = new FormData();
  form.append("file", file);
  const res = await client.post<DevicesPublic>(`/devices/upload?dry_run=${dry_run}`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
};

export interface StateItem {
  addr: string;
  state: "up" | "down";
  ts: number;
  room_id?: string;
  hostname?: string;
}

export interface StateResponse {
  page: number;
  size: number;
  total: number;
  items: StateItem[];
}

export const getState = async (page = 1, size = 100) => {
  const res = await client.get<StateResponse>("/state", { params: { page, size } });
  return res.data;
};
