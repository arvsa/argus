import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveFeedProvider } from "@/hooks/useLiveFeed";
import { WsIndicator } from "@/components/WsIndicator";
import { LiveFeedPanel } from "@/components/LiveFeedPanel";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  url: string;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }
}

function renderHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LiveFeedProvider>
        <WsIndicator />
        <LiveFeedPanel />
      </LiveFeedProvider>
    </QueryClientProvider>
  );
  return { queryClient };
}

describe("useLiveFeed / WsIndicator / LiveFeedPanel", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows connecting before the socket opens", () => {
    renderHarness();
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it("shows live once the socket opens", async () => {
    renderHarness();
    act(() => MockWebSocket.instances[0].onopen?.());

    expect(await screen.findByText(/^live$/i)).toBeInTheDocument();
  });

  it("shows disconnected once the socket closes", async () => {
    renderHarness();
    const socket = MockWebSocket.instances[0];
    act(() => socket.onopen?.());
    await screen.findByText(/^live$/i);

    act(() => socket.onclose?.());
    expect(await screen.findByText(/disconnected/i)).toBeInTheDocument();
  });

  it("shows connection error when the socket errors", async () => {
    renderHarness();
    act(() => MockWebSocket.instances[0].onerror?.());

    expect(await screen.findByText(/connection error/i)).toBeInTheDocument();
  });

  it("shows a placeholder when no events have arrived yet", () => {
    renderHarness();
    expect(screen.getByText(/no live events yet/i)).toBeInTheDocument();
  });

  it("renders an incoming enveloped event in the feed panel", async () => {
    renderHarness();
    const socket = MockWebSocket.instances[0];
    act(() => socket.onopen?.());

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          channel: "pings:events",
          data: JSON.stringify({ addr: "192.0.2.9", ok: false, ts: 1700000000000, interval_ms: 5000 }),
        }),
      })
    );

    expect(await screen.findByText("192.0.2.9")).toBeInTheDocument();
    expect(screen.getByText("down")).toBeInTheDocument();
  });

  it("ignores a malformed message without crashing", async () => {
    renderHarness();
    const socket = MockWebSocket.instances[0];
    act(() => socket.onopen?.());

    act(() => socket.onmessage?.({ data: "not json at all" }));

    await screen.findByText(/^live$/i);
    expect(screen.getByText(/no live events yet/i)).toBeInTheDocument();
  });

  it("invalidates the stats query when an event arrives", async () => {
    const { queryClient } = renderHarness();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const socket = MockWebSocket.instances[0];
    act(() => socket.onopen?.());

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          channel: "pings:events",
          data: JSON.stringify({ addr: "1.1.1.1", ok: true, ts: 1, interval_ms: 5000 }),
        }),
      })
    );

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["stats"] });
  });

  it("ignores a message delivered to a stale socket after React StrictMode's double-invoke tears it down", async () => {
    // StrictMode intentionally double-invokes effects in dev (mount ->
    // cleanup -> mount) to surface exactly this kind of bug: a socket from
    // the first invocation can still be alive momentarily and deliver an
    // event after its own effect instance has already been cleaned up.
    // Without a guard, that produces the duplicate live-feed rows seen in
    // production (each event appended once by the stale socket and once by
    // the real one).
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <LiveFeedProvider>
            <LiveFeedPanel />
          </LiveFeedProvider>
        </QueryClientProvider>
      </StrictMode>
    );

    expect(MockWebSocket.instances).toHaveLength(2);
    const [stale, live] = MockWebSocket.instances;

    const message = {
      data: JSON.stringify({
        channel: "pings:events",
        data: JSON.stringify({ addr: "10.1.0.3", ok: false, ts: 1, interval_ms: 5000 }),
      }),
    };

    act(() => live.onmessage?.(message));
    act(() => stale.onmessage?.(message));

    await screen.findByText("10.1.0.3");
    expect(screen.getAllByText("10.1.0.3")).toHaveLength(1);
  });

  it("invalidates node-stats when a per-node event arrives", async () => {
    const { queryClient } = renderHarness();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const socket = MockWebSocket.instances[0];
    act(() => socket.onopen?.());

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          channel: "events:node:node-1",
          data: JSON.stringify({ addr: "1.1.1.1", ok: true, ts: 1, interval_ms: 5000 }),
        }),
      })
    );

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["node-stats"] });
  });

  it("does not invalidate node-stats for the fixed fallback channel", async () => {
    const { queryClient } = renderHarness();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const socket = MockWebSocket.instances[0];
    act(() => socket.onopen?.());

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          channel: "pings:events",
          data: JSON.stringify({ addr: "1.1.1.1", ok: true, ts: 1, interval_ms: 5000 }),
        }),
      })
    );

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["node-stats"] });
  });
});
