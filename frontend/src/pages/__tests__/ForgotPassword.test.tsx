import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ForgotPassword } from "@/pages/ForgotPassword";
import * as authApi from "@/api/auth";

vi.mock("@/api/auth", () => ({
  forgotPassword: vi.fn(),
}));

function renderForgotPassword() {
  return render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ForgotPassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a validation error for an empty submission", async () => {
    const user = userEvent.setup();
    renderForgotPassword();

    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByText(/invalid email/i)).toBeInTheDocument();
    expect(authApi.forgotPassword).not.toHaveBeenCalled();
  });

  it("shows the check-your-email confirmation on submit, regardless of whether the address exists", async () => {
    vi.mocked(authApi.forgotPassword).mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderForgotPassword();

    await user.type(screen.getByPlaceholderText(/you@example.com/i), "user@example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
    expect(authApi.forgotPassword).toHaveBeenCalledWith("user@example.com");
  });

  it("shows an error message if the request itself fails", async () => {
    vi.mocked(authApi.forgotPassword).mockRejectedValue(new Error("network error"));
    const user = userEvent.setup();
    renderForgotPassword();

    await user.type(screen.getByPlaceholderText(/you@example.com/i), "user@example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });
});
