import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UsersPage } from "@/pages/admin/Users";
import * as usersApi from "@/api/users";
import { useAuthStore } from "@/store/auth";
import type { User } from "@/store/auth";

vi.mock("@/api/users", () => ({
  getUsers: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
}));

function user(overrides: Partial<User> = {}): User {
  return {
    id: "u-1",
    email: "alice@example.com",
    full_name: "Alice Example",
    is_active: true,
    is_superuser: false,
    admission_status: "pending",
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <UsersPage />
    </QueryClientProvider>
  );
}

describe("UsersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ token: "tok", user: user({ id: "current-user" }) });
  });

  it("renders users once loaded", async () => {
    vi.mocked(usersApi.getUsers).mockResolvedValue({ data: [user()], count: 1 });
    renderPage();

    expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("Alice Example")).toBeInTheDocument();
    expect(screen.getByText("Pending", { selector: "span" })).toBeInTheDocument();
  });

  it("shows an error state with retry when the request fails", async () => {
    vi.mocked(usersApi.getUsers).mockRejectedValue(new Error("network error"));
    renderPage();

    expect(await screen.findByText(/couldn't load users/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows an empty state when no users match the filter", async () => {
    vi.mocked(usersApi.getUsers).mockResolvedValue({
      data: [user({ admission_status: "approved" })],
      count: 1,
    });
    const testUser = userEvent.setup();
    renderPage();

    await screen.findByText("alice@example.com");
    await testUser.click(screen.getByRole("button", { name: /^pending$/i }));

    expect(await screen.findByText(/no users match/i)).toBeInTheDocument();
  });

  it("filters the list by admission status", async () => {
    vi.mocked(usersApi.getUsers).mockResolvedValue({
      data: [
        user({ id: "u-1", email: "pending@example.com", admission_status: "pending" }),
        user({ id: "u-2", email: "approved@example.com", admission_status: "approved" }),
      ],
      count: 2,
    });
    const testUser = userEvent.setup();
    renderPage();

    await screen.findByText("pending@example.com");
    expect(screen.getByText("approved@example.com")).toBeInTheDocument();

    await testUser.click(screen.getByRole("button", { name: /^approved$/i }));

    expect(screen.queryByText("pending@example.com")).not.toBeInTheDocument();
    expect(screen.getByText("approved@example.com")).toBeInTheDocument();
  });

  it("creates a user from the Add user form", async () => {
    vi.mocked(usersApi.getUsers).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(usersApi.createUser).mockResolvedValue(user({ id: "u-2" }));
    const testUser = userEvent.setup();
    renderPage();

    await testUser.click(await screen.findByRole("button", { name: /add user/i }));
    await testUser.type(screen.getByLabelText(/^email$/i), "new@example.com");
    await testUser.type(screen.getByLabelText(/^password$/i), "supersecret123");
    await testUser.click(screen.getByRole("button", { name: /^create user$/i }));

    expect(usersApi.createUser).toHaveBeenCalledWith(
      {
        email: "new@example.com",
        password: "supersecret123",
        full_name: "",
        is_superuser: false,
      },
      expect.anything()
    );
  });

  it("edits a user's admission status via the Edit form", async () => {
    vi.mocked(usersApi.getUsers).mockResolvedValue({ data: [user()], count: 1 });
    vi.mocked(usersApi.updateUser).mockResolvedValue(user({ admission_status: "approved" }));
    const testUser = userEvent.setup();
    renderPage();

    await testUser.click(await screen.findByRole("button", { name: /edit alice example/i }));
    await testUser.selectOptions(screen.getByLabelText(/admission status/i), "approved");
    await testUser.click(screen.getByRole("button", { name: /^save$/i }));

    expect(usersApi.updateUser).toHaveBeenCalledWith(
      "u-1",
      expect.objectContaining({ admission_status: "approved" })
    );
  });

  it("does not send a password change when the field is left blank", async () => {
    vi.mocked(usersApi.getUsers).mockResolvedValue({ data: [user()], count: 1 });
    vi.mocked(usersApi.updateUser).mockResolvedValue(user());
    const testUser = userEvent.setup();
    renderPage();

    await testUser.click(await screen.findByRole("button", { name: /edit alice example/i }));
    await testUser.click(screen.getByRole("button", { name: /^save$/i }));

    const [, payload] = vi.mocked(usersApi.updateUser).mock.calls[0];
    expect(payload).not.toHaveProperty("password");
  });

  it("deletes a user after confirming", async () => {
    vi.mocked(usersApi.getUsers).mockResolvedValue({ data: [user()], count: 1 });
    vi.mocked(usersApi.deleteUser).mockResolvedValue(undefined);
    const testUser = userEvent.setup();
    renderPage();

    await testUser.click(await screen.findByRole("button", { name: /delete alice example/i }));
    await testUser.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(usersApi.deleteUser).toHaveBeenCalledWith("u-1");
  });

  it("hides the delete action for the currently logged-in user", async () => {
    vi.mocked(usersApi.getUsers).mockResolvedValue({
      data: [user({ id: "current-user", email: "me@example.com", full_name: "Me" })],
      count: 1,
    });
    renderPage();

    await screen.findByText("me@example.com");
    expect(screen.queryByRole("button", { name: /delete me/i })).not.toBeInTheDocument();
  });
});
