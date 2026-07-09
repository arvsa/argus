import client from "./client";

// A Device is the bridge between a monitored address and a place in the
// Node hierarchy (see plan/device-node-assignment-bridge-v1.md).
// Deliberately not "@/api/devices" -- that file already exports an
// unrelated DeviceState/getState for the live ping-status page.
export interface DeviceAssignment {
  id: string;
  addr: string;
  node_id: string | null;
  created_at: string | null;
}

export interface DeviceAssignmentsPublic {
  data: DeviceAssignment[];
  count: number;
}

export const getDeviceAssignments = async (params: { nodeId: string }) => {
  const res = await client.get<DeviceAssignmentsPublic>("/devices/", {
    params: { node_id: params.nodeId, limit: 1000 },
  });
  return res.data;
};

export const createDeviceAssignment = async (data: { addr: string; node_id: string }) => {
  const res = await client.post<DeviceAssignment>("/devices/", data);
  return res.data;
};

export const deleteDeviceAssignment = async (id: string) => {
  await client.delete(`/devices/${id}`);
};
