import client from "./client";

export interface Building {
  id: string;
  name: string;
  campus_id: string;
  description?: string;
  created_at: string;
}

export interface BuildingsPublic {
  data: Building[];
  count: number;
}

export const getBuildings = async (skip = 0, limit = 100) => {
  const res = await client.get<BuildingsPublic>("/buildings/", { params: { skip, limit } });
  return res.data;
};

export const getBuilding = async (id: string) => {
  const res = await client.get<Building>(`/buildings/${id}`);
  return res.data;
};

export const createBuilding = async (data: {
  name: string;
  campus_id: string;
  description?: string;
}) => {
  const res = await client.post<Building>("/buildings/", data);
  return res.data;
};

export const updateBuilding = async (
  id: string,
  data: { name: string; campus_id: string; description?: string }
) => {
  const res = await client.put<Building>(`/buildings/${id}`, data);
  return res.data;
};

export const deleteBuilding = async (id: string) => {
  await client.delete(`/buildings/${id}`);
};
