import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RequireAuth, RequireSuperuser } from "@/layouts/RequireAuth";
import { useAuthStore } from "@/store/auth";
import type { User } from "@/store/auth";

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

function renderAt(path: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/protected" element={element}>
          <Route index element={<div>Protected Content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("RequireAuth", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, user: null });
  });

  it("redirects to /login when there is no token", () => {
    renderAt("/protected", <RequireAuth />);
    expect(screen.getByText("Login Page")).toBeInTheDocument();
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
  });

  it("renders the protected route when a token is present", () => {
    useAuthStore.setState({ token: "abc123", user: makeUser() });
    renderAt("/protected", <RequireAuth />);
    expect(screen.getByText("Protected Content")).toBeInTheDocument();
  });
});

describe("RequireSuperuser", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, user: null });
  });

  it("shows an access-required message for a non-superuser", () => {
    useAuthStore.setState({ token: "abc123", user: makeUser({ is_superuser: false }) });
    renderAt("/protected", <RequireSuperuser />);
    expect(screen.getByText(/superuser access required/i)).toBeInTheDocument();
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
  });

  it("renders the protected route for a superuser", () => {
    useAuthStore.setState({ token: "abc123", user: makeUser({ is_superuser: true }) });
    renderAt("/protected", <RequireSuperuser />);
    expect(screen.getByText("Protected Content")).toBeInTheDocument();
  });

  it("shows the access-required message when there is no user at all", () => {
    renderAt("/protected", <RequireSuperuser />);
    expect(screen.getByText(/superuser access required/i)).toBeInTheDocument();
  });
});
