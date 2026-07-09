import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdmissionBadge } from "@/components/AdmissionBadge";

describe("AdmissionBadge", () => {
  it("renders Pending", () => {
    render(<AdmissionBadge status="pending" />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("renders Approved", () => {
    render(<AdmissionBadge status="approved" />);
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it("renders Rejected", () => {
    render(<AdmissionBadge status="rejected" />);
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });
});
