import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Register } from "@/pages/Register";
import * as authApi from "@/api/auth";

vi.mock("@/api/auth", () => ({
  register: vi.fn(),
}));

function renderRegister() {
  return render(
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows validation errors for an empty submission", async () => {
    const user = userEvent.setup();
    renderRegister();

    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/invalid email/i)).toBeInTheDocument();
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it("registers successfully and shows the pending-approval message", async () => {
    vi.mocked(authApi.register).mockResolvedValue({ id: "u1" });
    const user = userEvent.setup();
    renderRegister();

    await user.type(screen.getByPlaceholderText(/you@example.com/i), "new@example.com");
    await user.type(screen.getByPlaceholderText("••••••••"), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/account created/i)).toBeInTheDocument();
    expect(screen.getByText(/pending approval/i)).toBeInTheDocument();
    expect(authApi.register).toHaveBeenCalledWith({
      email: "new@example.com",
      password: "password123",
      full_name: "",
    });
  });

  it("shows the server's error message when registration fails", async () => {
    vi.mocked(authApi.register).mockRejectedValue({
      response: { data: { detail: "Email already registered" } },
      isAxiosError: true,
    });
    const user = userEvent.setup();
    renderRegister();

    await user.type(screen.getByPlaceholderText(/you@example.com/i), "dup@example.com");
    await user.type(screen.getByPlaceholderText("••••••••"), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/email already registered/i)).toBeInTheDocument();
    expect(screen.queryByText(/account created/i)).not.toBeInTheDocument();
  });
});
