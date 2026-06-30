import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Login } from "@/pages/Login";
import { useAuthStore } from "@/store/auth";
import * as authApi from "@/api/auth";

vi.mock("@/api/auth", () => ({
  login: vi.fn(),
  getMe: vi.fn(),
}));

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<div>Dashboard Page</div>} />
        <Route path="/register" element={<div>Register Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ token: null, user: null });
  });

  it("shows validation errors for an empty submission", async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(/invalid email/i)).toBeInTheDocument();
    expect(authApi.login).not.toHaveBeenCalled();
  });

  it("shows a validation error for a malformed email", async () => {
    const user = userEvent.setup();
    renderLogin();

    // "user@localhost" satisfies the browser's native HTML5 <input type="email"> constraint
    // (so jsdom doesn't block the submit event before React ever sees it) but still fails
    // zod's stricter email().pattern (no TLD), exercising our own validation message.
    await user.type(screen.getByPlaceholderText(/you@example.com/i), "user@localhost");
    await user.type(screen.getByPlaceholderText("••••••••"), "password123");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(/invalid email/i)).toBeInTheDocument();
    expect(authApi.login).not.toHaveBeenCalled();
  });

  it("logs in successfully, stores the session, and navigates to the dashboard", async () => {
    vi.mocked(authApi.login).mockResolvedValue({ access_token: "tok-123", token_type: "bearer" });
    vi.mocked(authApi.getMe).mockResolvedValue({
      id: "u1",
      email: "user@example.com",
      full_name: "Test User",
      is_active: true,
      is_superuser: false,
      admission_status: "approved",
      created_at: "2024-01-01T00:00:00Z",
    });

    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByPlaceholderText(/you@example.com/i), "user@example.com");
    await user.type(screen.getByPlaceholderText("••••••••"), "password123");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Dashboard Page")).toBeInTheDocument();
    expect(useAuthStore.getState().token).toBe("tok-123");
    expect(useAuthStore.getState().user?.email).toBe("user@example.com");
  });

  it("shows an error message and does not navigate on invalid credentials", async () => {
    vi.mocked(authApi.login).mockRejectedValue(new Error("401"));

    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByPlaceholderText(/you@example.com/i), "user@example.com");
    await user.type(screen.getByPlaceholderText("••••••••"), "wrong-password");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
    expect(screen.queryByText("Dashboard Page")).not.toBeInTheDocument();
    expect(useAuthStore.getState().token).toBeNull();
  });
});
