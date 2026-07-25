import client from "./client";

// Mirrors the backend's InfraPollTarget config (plan/device-discovery-
// v1.md §2.6) -- which routers/switches pingsvc's discovery subsystem
// should poll via SNMP for ARP-table discovery.
export interface InfraTarget {
  id: string;
  addr: string;
  kind: "router" | "switch";
  enabled: boolean;
  created_at: string | null;
  // Never the plaintext -- write-only, same convention as the
  // encryption-key panel in plan/optional-snapshot-encryption-v1.md.
  community_set: boolean;
}

export interface InfraTargetsPublic {
  data: InfraTarget[];
  count: number;
}

export const getInfraTargets = async () => {
  const res = await client.get<InfraTargetsPublic>("/discovery/infra-targets");
  return res.data;
};

export const createInfraTarget = async (data: {
  addr: string;
  kind: "router" | "switch";
  community: string;
  enabled?: boolean;
}) => {
  const res = await client.post<InfraTarget>("/discovery/infra-targets", data);
  return res.data;
};

export const updateInfraTarget = async (
  id: string,
  data: Partial<{
    addr: string;
    kind: "router" | "switch";
    community: string;
    enabled: boolean;
  }>
) => {
  const res = await client.patch<InfraTarget>(`/discovery/infra-targets/${id}`, data);
  return res.data;
};

export const deleteInfraTarget = async (id: string) => {
  await client.delete(`/discovery/infra-targets/${id}`);
};
