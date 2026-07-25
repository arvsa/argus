import client from "./client";

// Mirrors the backend's DiscoveredDevice candidate pool (plan/device-
// discovery-v1.md §2.2/§2.7) -- pingsvc's discovery subsystem reports
// sightings here; an operator reviews and approves/rejects before one
// becomes a real, monitored Device.
export interface DiscoveredDevice {
  id: string;
  addr: string;
  mac: string | null;
  hostname: string | null;
  discovered_via: string;
  status: "pending" | "approved" | "rejected";
  first_seen_at: string;
  last_seen_at: string;
  // Computed at read time against DISCOVERY_STALE_THRESHOLD_SECONDS --
  // not reconfirmed by any poll cycle recently (plan §2.5).
  is_stale: boolean;
}

export interface DiscoveredDevicesPublic {
  data: DiscoveredDevice[];
  count: number;
}

export const getDiscoveredDevices = async () => {
  const res = await client.get<DiscoveredDevicesPublic>("/devices/discovered");
  return res.data;
};

export const approveDiscoveredDevice = async (id: string) => {
  const res = await client.post<DiscoveredDevice>(`/devices/discovered/${id}/approve`);
  return res.data;
};

export const rejectDiscoveredDevice = async (id: string) => {
  const res = await client.post<DiscoveredDevice>(`/devices/discovered/${id}/reject`);
  return res.data;
};
