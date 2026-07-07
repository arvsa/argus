import { describe, it, expect, beforeEach } from "vitest";
import client from "@/api/client";
import { useAuthStore } from "@/store/auth";

// axios doesn't expose a public API to invoke a registered interceptor
// directly; reaching into interceptors.<...>.handlers[0] is the standard
// pragmatic way to unit-test interceptor logic without a mock HTTP server.

describe("api client request interceptor", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, user: null });
  });

  it("attaches the Authorization header when a token is present", () => {
    useAuthStore.setState({ token: "abc123", user: null });
    const fulfilled = (client.interceptors.request as any).handlers[0].fulfilled;
    const config = fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBe("Bearer abc123");
  });

  it("does not attach an Authorization header when there is no token", () => {
    const fulfilled = (client.interceptors.request as any).handlers[0].fulfilled;
    const config = fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBeUndefined();
  });
});

describe("api client response interceptor", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: "abc123", user: null });
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href: "" },
    });
  });

  it("logs out and redirects to /login on a 401 response", async () => {
    const rejected = (client.interceptors.response as any).handlers[0].rejected;
    await expect(rejected({ response: { status: 401 } })).rejects.toBeTruthy();

    expect(useAuthStore.getState().token).toBeNull();
    expect(window.location.href).toBe("/login");
  });

  it("does not log out on a non-401 error", async () => {
    const rejected = (client.interceptors.response as any).handlers[0].rejected;
    await expect(rejected({ response: { status: 500 } })).rejects.toBeTruthy();

    expect(useAuthStore.getState().token).toBe("abc123");
    expect(window.location.href).toBe("");
  });
});
