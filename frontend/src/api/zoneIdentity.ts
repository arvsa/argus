import client from "./client";

// This zone's own connection info, proxied from pingsvc's /identity
// (see backend/app/api/routes/utils.py:zone_identity and
// pingsvc/cmd/pingsvc/identity.go). public_key_hex is absent until the
// exporter has generated/loaded a signing key.
export interface ZoneIdentity {
  zone_id: string;
  tenant_id: string;
  public_key_hex?: string | null;
}

export const getZoneIdentity = async () => {
  const res = await client.get<ZoneIdentity>("/utils/zone-identity");
  return res.data;
};
