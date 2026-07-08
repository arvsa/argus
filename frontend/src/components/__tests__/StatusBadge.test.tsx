import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/components/StatusBadge";

describe("StatusBadge", () => {
  it("renders Up when the device is up", () => {
    render(<StatusBadge up={true} />);
    expect(screen.getByText("Up")).toBeInTheDocument();
  });

  it("renders Down when the device is down", () => {
    render(<StatusBadge up={false} />);
    expect(screen.getByText("Down")).toBeInTheDocument();
  });
});
