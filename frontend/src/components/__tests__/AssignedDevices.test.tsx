import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssignedDevices } from "@/components/AssignedDevices";
import * as deviceAssignmentsApi from "@/api/deviceAssignments";
import type { DeviceAssignment } from "@/api/deviceAssignments";

vi.mock("@/api/deviceAssignments", () => ({
  getDeviceAssignments: vi.fn(),
  createDeviceAssignment: vi.fn(),
  deleteDeviceAssignment: vi.fn(),
  bulkImportDeviceAssignments: vi.fn(),
}));

function device(overrides: Partial<DeviceAssignment> = {}): DeviceAssignment {
  return {
    id: "dev-1",
    addr: "10.0.1.5",
    node_id: "node-1",
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderComponent(nodeId = "node-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AssignedDevices nodeId={nodeId} />
    </QueryClientProvider>
  );
}

describe("AssignedDevices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches devices scoped to the given node", async () => {
    vi.mocked(deviceAssignmentsApi.getDeviceAssignments).mockResolvedValue({
      data: [device()],
      count: 1,
    });
    renderComponent("node-1");

    await screen.findByText("10.0.1.5");
    expect(deviceAssignmentsApi.getDeviceAssignments).toHaveBeenCalledWith({ nodeId: "node-1" });
  });

  it("shows an empty state when no devices are assigned", async () => {
    vi.mocked(deviceAssignmentsApi.getDeviceAssignments).mockResolvedValue({ data: [], count: 0 });
    renderComponent();

    expect(await screen.findByText(/no devices assigned to this node yet/i)).toBeInTheDocument();
  });

  it("shows an error state with retry when the request fails", async () => {
    vi.mocked(deviceAssignmentsApi.getDeviceAssignments).mockRejectedValue(new Error("boom"));
    renderComponent();

    expect(await screen.findByText(/couldn't load devices/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("adds a device via the Add form", async () => {
    vi.mocked(deviceAssignmentsApi.getDeviceAssignments).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(deviceAssignmentsApi.createDeviceAssignment).mockResolvedValue(device());
    const user = userEvent.setup();
    renderComponent("node-1");

    await screen.findByText(/no devices assigned to this node yet/i);
    await user.click(screen.getByRole("button", { name: /^add$/i }));
    await user.type(screen.getByLabelText(/address/i), "10.0.1.9");
    await user.click(screen.getByRole("button", { name: /^add device$/i }));

    expect(deviceAssignmentsApi.createDeviceAssignment).toHaveBeenCalledWith({
      addr: "10.0.1.9",
      node_id: "node-1",
    });
  });

  it("adds a device with a name via the Add form", async () => {
    vi.mocked(deviceAssignmentsApi.getDeviceAssignments).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(deviceAssignmentsApi.createDeviceAssignment).mockResolvedValue(device());
    const user = userEvent.setup();
    renderComponent("node-1");

    await screen.findByText(/no devices assigned to this node yet/i);
    await user.click(screen.getByRole("button", { name: /^add$/i }));
    await user.type(screen.getByLabelText(/address/i), "10.0.1.9");
    await user.type(screen.getByLabelText(/^name/i), "floor-1-switch");
    await user.click(screen.getByRole("button", { name: /^add device$/i }));

    expect(deviceAssignmentsApi.createDeviceAssignment).toHaveBeenCalledWith({
      addr: "10.0.1.9",
      node_id: "node-1",
      hostname: "floor-1-switch",
    });
  });

  it("bulk-imports devices from pasted CSV, scoped to this node", async () => {
    vi.mocked(deviceAssignmentsApi.getDeviceAssignments).mockResolvedValue({ data: [], count: 0 });
    vi.mocked(deviceAssignmentsApi.bulkImportDeviceAssignments).mockResolvedValue({
      results: [
        { row: 0, addr: "10.0.1.10", outcome: "created", error: null, device: device() },
        {
          row: 1,
          addr: "10.0.1.11",
          outcome: "skipped_duplicate",
          error: null,
          device: null,
        },
      ],
    });
    const user = userEvent.setup();
    renderComponent("node-1");

    await screen.findByText(/no devices assigned to this node yet/i);
    await user.click(screen.getByRole("button", { name: /bulk import/i }));
    await user.type(
      screen.getByLabelText(/paste csv/i),
      "addr,hostname{Enter}10.0.1.10,a{Enter}10.0.1.11,b"
    );
    await user.click(screen.getByRole("button", { name: /^import$/i }));

    expect(deviceAssignmentsApi.bulkImportDeviceAssignments).toHaveBeenCalledWith([
      { addr: "10.0.1.10", hostname: "a", node_id: "node-1" },
      { addr: "10.0.1.11", hostname: "b", node_id: "node-1" },
    ]);
    expect(await screen.findByText(/1 created/i)).toBeInTheDocument();
    expect(screen.getByText(/1 skipped/i)).toBeInTheDocument();
  });

  it("shows a client-side parse error without calling the API", async () => {
    vi.mocked(deviceAssignmentsApi.getDeviceAssignments).mockResolvedValue({ data: [], count: 0 });
    const user = userEvent.setup();
    renderComponent("node-1");

    await screen.findByText(/no devices assigned to this node yet/i);
    await user.click(screen.getByRole("button", { name: /bulk import/i }));
    await user.type(screen.getByLabelText(/paste csv/i), "hostname{Enter}floor-1-switch");
    await user.click(screen.getByRole("button", { name: /^import$/i }));

    expect(await screen.findByText(/missing required "addr" column/i)).toBeInTheDocument();
    expect(deviceAssignmentsApi.bulkImportDeviceAssignments).not.toHaveBeenCalled();
  });

  it("removes a device after confirming", async () => {
    vi.mocked(deviceAssignmentsApi.getDeviceAssignments).mockResolvedValue({
      data: [device()],
      count: 1,
    });
    vi.mocked(deviceAssignmentsApi.deleteDeviceAssignment).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderComponent();

    await user.click(await screen.findByRole("button", { name: /remove 10.0.1.5/i }));
    await user.click(screen.getByRole("button", { name: /^remove$/i }));

    expect(deviceAssignmentsApi.deleteDeviceAssignment).toHaveBeenCalledWith("dev-1");
  });
});
