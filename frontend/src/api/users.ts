import client from "./client";
import type { User } from "@/store/auth";

export interface UsersPublic {
  data: User[];
  count: number;
}

export const getUsers = async (skip = 0, limit = 100) => {
  const res = await client.get<UsersPublic>("/users/", { params: { skip, limit } });
  return res.data;
};

export const getUser = async (id: string) => {
  const res = await client.get<User>(`/users/${id}`);
  return res.data;
};

export const createUser = async (data: {
  email: string;
  password: string;
  full_name?: string;
  is_superuser?: boolean;
}) => {
  const res = await client.post<User>("/users/", data);
  return res.data;
};

export const updateUser = async (
  id: string,
  data: Partial<{
    email: string;
    full_name: string;
    is_superuser: boolean;
    is_active: boolean;
    admission_status: string;
    password: string;
  }>
) => {
  const res = await client.patch<User>(`/users/${id}`, data);
  return res.data;
};

export const deleteUser = async (id: string) => {
  await client.delete(`/users/${id}`);
};

export const updateMe = async (data: { full_name?: string; email?: string }) => {
  const res = await client.patch<User>("/users/me", data);
  return res.data;
};

export const changePassword = async (data: {
  current_password: string;
  new_password: string;
}) => {
  const res = await client.patch("/users/me/password", data);
  return res.data;
};
