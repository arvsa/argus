import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Activity } from "lucide-react";
import { StatCard } from "@/components/StatCard";

describe("StatCard", () => {
  it("renders the label and value", () => {
    render(<StatCard label="Total devices" value={42} />);

    expect(screen.getByText("Total devices")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders an icon when provided", () => {
    render(<StatCard label="Up" value={10} icon={Activity} tone="success" />);

    expect(document.querySelector("svg")).toBeInTheDocument();
  });

  it("renders without an icon when none is provided", () => {
    render(<StatCard label="Down" value={0} />);

    expect(document.querySelector("svg")).not.toBeInTheDocument();
  });
});
