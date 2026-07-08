import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Profile } from "@/pages/Profile";
import { useAuthStore } from "@/store/auth";
import type { User } from "@/store/auth";
import * as usersApi from "@/api/users";

vi.mock("@/api/users", () => ({
  updateMe: vi.fn(),
  changePassword: vi.fn(),
}));

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    email: "user@example.com",
    full_name: "Test User",
    is_active: true,
    is_superuser: false,
    admission_status: "approved",
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderProfile() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Profile />
    </QueryClientProvider>
  );
}

describe("Profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ token: "tok", user: makeUser() });
  });

  it("shows the current user's admission status and role", () => {
    renderProfile();
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  it("shows Superuser for a superuser account", () => {
    useAuthStore.setState({ token: "tok", user: makeUser({ is_superuser: true }) });
    renderProfile();
    expect(screen.getByText("Superuser")).toBeInTheDocument();
  });

  it("updates the profile and shows a success message", async () => {
    vi.mocked(usersApi.updateMe).mockResolvedValue(makeUser({ full_name: "New Name" }));
    const user = userEvent.setup();
    renderProfile();

    const nameInput = screen.getByDisplayValue("Test User");
    await user.clear(nameInput);
    await user.type(nameInput, "New Name");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/profile updated/i)).toBeInTheDocument();
    // useMutation's mutationFn is invoked with a second React Query context
    // argument (client/meta/mutationKey) beyond the variables we pass in.
    expect(usersApi.updateMe).toHaveBeenCalledWith(
      { full_name: "New Name", email: "user@example.com" },
      expect.anything()
    );
    expect(useAuthStore.getState().user?.full_name).toBe("New Name");
  });

  it("changes the password and shows a success message", async () => {
    vi.mocked(usersApi.changePassword).mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderProfile();

    const [current, next, confirm] = screen.getAllByPlaceholderText("••••••••");
    await user.type(current, "oldpassword123");
    await user.type(next, "newpassword123");
    await user.type(confirm, "newpassword123");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText(/password updated/i)).toBeInTheDocument();
    expect(usersApi.changePassword).toHaveBeenCalledWith({
      current_password: "oldpassword123",
      new_password: "newpassword123",
    });
  });

  it("shows a validation error when the new passwords don't match", async () => {
    const user = userEvent.setup();
    renderProfile();

    const [current, next, confirm] = screen.getAllByPlaceholderText("••••••••");
    await user.type(current, "oldpassword123");
    await user.type(next, "newpassword123");
    await user.type(confirm, "different123");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(usersApi.changePassword).not.toHaveBeenCalled();
  });

  it("shows an incorrect-password message when the current password is wrong", async () => {
    vi.mocked(usersApi.changePassword).mockRejectedValue(new Error("400"));
    const user = userEvent.setup();
    renderProfile();

    const [current, next, confirm] = screen.getAllByPlaceholderText("••••••••");
    await user.type(current, "wrongpassword");
    await user.type(next, "newpassword123");
    await user.type(confirm, "newpassword123");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText(/incorrect current password/i)).toBeInTheDocument();
  });
});
