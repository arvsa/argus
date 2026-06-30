import axios from "axios";

/**
 * Extracts a user-presentable message from an API error.
 * FastAPI validation/HTTP errors return `{ detail: string | object }`;
 * network failures (no response at all) get a distinct message.
 */
export function getErrorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (axios.isAxiosError(err)) {
    if (!err.response) return "Network error — check your connection and try again.";
    const detail = err.response.data?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg;
    if (err.response.status === 404) return "Not found.";
    if (err.response.status === 403) return "You don't have permission to do that.";
  }
  return fallback;
}
