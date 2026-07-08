import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ZoneEmptyState } from "@/components/ZoneEmptyState";

describe("ZoneEmptyState", () => {
  it("explains that zone tracking isn't configured for this deployment", () => {
    render(<ZoneEmptyState />);
    expect(screen.getByText(/not configured for this deployment/i)).toBeInTheDocument();
  });
});
