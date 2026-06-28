import client from "./client";

export interface Campus {
  id: string;
  name: string;
  description?: string;
  created_at: string;
}

export interface CampusesPublic {
  data: Campus[];
  count: number;
}

export const getCampuses = async (skip = 0, limit = 100) => {
  const res = await client.get<CampusesPublic>("/campuses/", { params: { skip, limit } });
  return res.data;
};

export const getCampus = async (id: string) => {
  const res = await client.get<Campus>(`/campuses/${id}`);
  return res.data;
};

export const createCampus = async (data: { name: string; description?: string }) => {
  const res = await client.post<Campus>("/campuses/", data);
  return res.data;
};

export const updateCampus = async (id: string, data: { name: string; description?: string }) => {
  const res = await client.put<Campus>(`/campuses/${id}`, data);
  return res.data;
};

export const deleteCampus = async (id: string) => {
  await client.delete(`/campuses/${id}`);
};
