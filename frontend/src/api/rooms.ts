import client from "./client";

export interface Room {
  id: string;
  name: string;
  building_id: string;
  description?: string;
  created_at: string;
}

export interface RoomsPublic {
  data: Room[];
  count: number;
}

export interface DeviceState {
  addr: string;
  state: "up" | "down";
  ts: number;
  room_id?: string;
  hostname?: string;
}

export const getRooms = async (skip = 0, limit = 100) => {
  const res = await client.get<RoomsPublic>("/rooms/", { params: { skip, limit } });
  return res.data;
};

export const getRoom = async (id: string) => {
  const res = await client.get<Room>(`/rooms/${id}`);
  return res.data;
};

export const getRoomStates = async (id: string) => {
  const res = await client.get<DeviceState[]>(`/rooms/${id}/states`);
  return res.data;
};

export const createRoom = async (data: {
  name: string;
  building_id: string;
  description?: string;
}) => {
  const res = await client.post<Room>("/rooms/", data);
  return res.data;
};

export const updateRoom = async (
  id: string,
  data: { name?: string; building_id?: string; description?: string }
) => {
  const res = await client.put<Room>(`/rooms/${id}`, data);
  return res.data;
};

export const deleteRoom = async (id: string) => {
  await client.delete(`/rooms/${id}`);
};
