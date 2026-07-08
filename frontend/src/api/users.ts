import client from "./client";
import type { User } from "@/store/auth";

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
