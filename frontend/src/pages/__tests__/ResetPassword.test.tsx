import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ResetPassword } from "@/pages/ResetPassword";
import * as authApi from "@/api/auth";

vi.mock("@/api/auth", () => ({
  resetPassword: vi.fn(),
}));

function renderResetPassword(search = "?token=abc123") {
  return render(
    <MemoryRouter initialEntries={[`/reset-password${search}`]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ResetPassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a validation error when the two passwords don't match", async () => {
    const user = userEvent.setup();
    renderResetPassword();

    const [newPw, confirmPw] = screen.getAllByPlaceholderText("••••••••");
    await user.type(newPw, "password123");
    await user.type(confirmPw, "different123");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(authApi.resetPassword).not.toHaveBeenCalled();
  });

  it("resets the password using the token from the URL and navigates to login", async () => {
    vi.mocked(authApi.resetPassword).mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderResetPassword("?token=the-real-token");

    const [newPw, confirmPw] = screen.getAllByPlaceholderText("••••••••");
    await user.type(newPw, "password123");
    await user.type(confirmPw, "password123");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(await screen.findByText("Login Page")).toBeInTheDocument();
    expect(authApi.resetPassword).toHaveBeenCalledWith("the-real-token", "password123");
  });

  it("shows an error message for an invalid or expired token", async () => {
    vi.mocked(authApi.resetPassword).mockRejectedValue(new Error("400"));
    const user = userEvent.setup();
    renderResetPassword();

    const [newPw, confirmPw] = screen.getAllByPlaceholderText("••••••••");
    await user.type(newPw, "password123");
    await user.type(confirmPw, "password123");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(await screen.findByText(/invalid or expired token/i)).toBeInTheDocument();
    expect(screen.queryByText("Login Page")).not.toBeInTheDocument();
  });
});
