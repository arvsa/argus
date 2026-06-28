import client from "./client";
import axios from "axios";

export async function login(email: string, password: string) {
  const form = new URLSearchParams();
  form.append("username", email);
  form.append("password", password);
  const res = await axios.post<{ access_token: string; token_type: string }>(
    "/api/v1/login/access-token",
    form,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return res.data;
}

export async function getMe(token?: string) {
  const res = await client.get("/users/me", {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  return res.data;
}

export async function register(data: {
  email: string;
  password: string;
  full_name?: string;
}) {
  const res = await client.post("/users/signup", data);
  return res.data;
}

export async function forgotPassword(email: string) {
  const res = await client.post(`/password-recovery/${encodeURIComponent(email)}`);
  return res.data;
}

export async function resetPassword(token: string, new_password: string) {
  const res = await client.post("/reset-password/", { token, new_password });
  return res.data;
}
