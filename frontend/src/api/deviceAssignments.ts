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

export const createDeviceAssignment = async (data: {
  addr: string;
  node_id: string;
  hostname?: string;
}) => {
  const res = await client.post<DeviceAssignment>("/devices/", data);
  return res.data;
};

export const deleteDeviceAssignment = async (id: string) => {
  await client.delete(`/devices/${id}`);
};

// Bulk import (plan/device-naming-and-bulk-import-v1.md §2.6): CSV parsing
// happens client-side (see @/lib/csv), the backend just applies the same
// per-row duplicate/orphan-reassignment logic as createDeviceAssignment,
// once per row, and reports a per-row outcome instead of all-or-nothing.
export interface BulkImportRow {
  addr: string;
  hostname?: string;
  mac?: string;
  timezone?: string;
  node_id?: string;
}

export interface BulkImportRowResult {
  row: number;
  addr: string | null;
  outcome: "created" | "reassigned" | "skipped_duplicate" | "error";
  error: string | null;
  device: DeviceAssignment | null;
}

export interface BulkImportResponse {
  results: BulkImportRowResult[];
}

export const bulkImportDeviceAssignments = async (rows: BulkImportRow[]) => {
  const res = await client.post<BulkImportResponse>("/devices/bulk-import", { rows });
  return res.data;
};
