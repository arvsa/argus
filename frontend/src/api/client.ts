import axios from "axios";
import { useAuthStore } from "@/store/auth";

const client = axios.create({
  baseURL: "/api/v1",
  headers: { "Content-Type": "application/json" },
});

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// The backend's get_current_user (backend/app/api/deps.py) raises 403, not
// 401, for a token that fails jwt.decode -- but a *valid* token hitting a
// superuser-only route also gets 403 ("doesn't have enough privileges").
// Only the former should force a logout; the latter is a legitimate,
// stay-logged-in permission denial that RequireSuperuser's own UI handles.
const INVALID_TOKEN_DETAIL = "Could not validate credentials";

client.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status;
    const isInvalidToken = status === 403 && err.response?.data?.detail === INVALID_TOKEN_DETAIL;
    if (status === 401 || isInvalidToken) {
      useAuthStore.getState().logout();
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export default client;
