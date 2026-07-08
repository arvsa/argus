import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UsersPage } from "@/pages/admin/Users";
import * as usersApi from "@/api/users";
import type { User } from "@/store/auth";

vi.mock("@/api/users", () => ({
  getUsers: vi.fn(),
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
});
