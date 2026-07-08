import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NodeStatusBadge } from "@/components/NodeStatusBadge";

describe("NodeStatusBadge", () => {
  it("renders the up and down counts", () => {
    render(<NodeStatusBadge up={12} down={2} />);
    expect(screen.getByText("12 up")).toBeInTheDocument();
    expect(screen.getByText("2 down")).toBeInTheDocument();
  });

  it("renders zeros when nothing is up or down", () => {
    render(<NodeStatusBadge up={0} down={0} />);
    expect(screen.getByText("0 up")).toBeInTheDocument();
    expect(screen.getByText("0 down")).toBeInTheDocument();
  });

  it("renders a placeholder while counts are unknown", () => {
    render(<NodeStatusBadge up={undefined} down={undefined} />);
    expect(screen.getByText("…")).toBeInTheDocument();
  });
});
