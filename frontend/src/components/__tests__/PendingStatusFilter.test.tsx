import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingStatusFilter } from "@/components/PendingStatusFilter";

describe("PendingStatusFilter", () => {
  it("renders all four filter options", () => {
    render(<PendingStatusFilter value="all" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^pending$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^approved$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^rejected$/i })).toBeInTheDocument();
  });

  it("calls onChange with the clicked status", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<PendingStatusFilter value="all" onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /^pending$/i }));
    expect(onChange).toHaveBeenCalledWith("pending");
  });

  it("marks the active filter as pressed", () => {
    render(<PendingStatusFilter value="pending" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^pending$/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^all$/i })).toHaveAttribute("aria-pressed", "false");
  });
});
