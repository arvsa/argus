import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Campuses } from "@/pages/Campuses";
import { useAuthStore } from "@/store/auth";
import type { User } from "@/store/auth";
import * as campusesApi from "@/api/campuses";
import type { Campus, CampusesPublic } from "@/api/campuses";

vi.mock("@/api/campuses", () => ({
  getCampuses: vi.fn(),
  createCampus: vi.fn(),
  updateCampus: vi.fn(),
  deleteCampus: vi.fn(),
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

function makeCampus(overrides: Partial<Campus> = {}): Campus {
  return {
    id: "c1",
    name: "Main Campus",
    description: "The main one",
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderCampuses() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Campuses />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Campuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ token: "tok", user: makeUser() });
  });

  it("renders the campus list for a regular (non-superuser) user without write controls", async () => {
    const list: CampusesPublic = { data: [makeCampus()], count: 1 };
    vi.mocked(campusesApi.getCampuses).mockResolvedValue(list);

    renderCampuses();

    expect(await screen.findByText("Main Campus")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new campus/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no campuses", async () => {
    vi.mocked(campusesApi.getCampuses).mockResolvedValue({ data: [], count: 0 });

    renderCampuses();

    expect(await screen.findByText(/no campuses yet/i)).toBeInTheDocument();
  });

  it("shows the New Campus action and creates a campus for a superuser", async () => {
    vi.mocked(campusesApi.getCampuses).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(campusesApi.createCampus).mockResolvedValue(makeCampus({ name: "New One" }));
    useAuthStore.setState({ token: "tok", user: makeUser({ is_superuser: true }) });

    const user = userEvent.setup();
    renderCampuses();

    const newButton = await screen.findByRole("button", { name: /new campus/i });
    await user.click(newButton);

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("Main Campus"), "New One");
    await user.click(within(dialog).getByRole("button", { name: /^save$/i }));

    expect(vi.mocked(campusesApi.createCampus).mock.calls[0][0]).toEqual(
      expect.objectContaining({ name: "New One" })
    );
  });

  it("edits an existing campus as a superuser", async () => {
    vi.mocked(campusesApi.getCampuses).mockResolvedValue({ data: [makeCampus()], count: 1 });
    vi.mocked(campusesApi.updateCampus).mockResolvedValue(makeCampus({ name: "Renamed Campus" }));
    useAuthStore.setState({ token: "tok", user: makeUser({ is_superuser: true }) });

    const user = userEvent.setup();
    renderCampuses();

    await screen.findByText("Main Campus");
    const row = screen.getByText("Main Campus").closest("tr")!;
    // The row's action cell renders an icon-only edit button followed by a delete button.
    await user.click(within(row).getAllByRole("button")[0]);

    const dialog = await screen.findByRole("dialog", { name: /edit campus/i });
    const nameInput = within(dialog).getByDisplayValue("Main Campus");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Campus");
    await user.click(within(dialog).getByRole("button", { name: /^save$/i }));

    expect(campusesApi.updateCampus).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ name: "Renamed Campus" })
    );
  });

  it("deletes a campus after confirming, as a superuser", async () => {
    vi.mocked(campusesApi.getCampuses).mockResolvedValue({ data: [makeCampus()], count: 1 });
    vi.mocked(campusesApi.deleteCampus).mockResolvedValue(undefined);
    useAuthStore.setState({ token: "tok", user: makeUser({ is_superuser: true }) });

    const user = userEvent.setup();
    renderCampuses();

    await screen.findByText("Main Campus");
    const row = screen.getByText("Main Campus").closest("tr")!;
    const buttons = within(row).getAllByRole("button");
    // Second action button in the row is delete (first is edit).
    await user.click(buttons[1]);

    const alert = await screen.findByRole("alertdialog");
    await user.click(within(alert).getByRole("button", { name: /^delete$/i }));

    expect(vi.mocked(campusesApi.deleteCampus).mock.calls[0][0]).toBe("c1");
  });
});
