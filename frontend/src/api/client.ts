import axios from "axios";
import { useAuthStore } from "@/store/auth";

const client = axios.create({
  baseURL: "/api/v1",
  headers: { "Content-Type": "application/json" },
});

client.interceptors.request.use((config) => {
  // Never override a caller-supplied Authorization header with the store's
  // token -- getMe() in the login flow passes the just-issued token
  // explicitly (setAuth() hasn't run yet, so the store may still hold a
  // stale one from a previous session/backend reset); clobbering that
  // would verify the wrong token and misreport a fresh login as failed.
  if (config.headers.Authorization) return config;
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export default client;
