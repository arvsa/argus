import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DeviceState } from "@/api/devices";

export type LiveFeedStatus = "connecting" | "open" | "closed" | "error";

export interface LiveFeedEvent {
  channel: string;
  data: DeviceState | null;
  raw: string;
  receivedAt: number;
}

const MAX_EVENTS = 20;
const KEEPALIVE_INTERVAL_MS = 20_000;

interface LiveFeedContextValue {
  status: LiveFeedStatus;
  events: LiveFeedEvent[];
}

const LiveFeedContext = createContext<LiveFeedContextValue | null>(null);

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/ws/pings`;
}

// The single WebSocket connection for the whole app -- mounted once (in
// AppShell) so WsIndicator and any live feed panel share one socket rather
// than each hook call opening its own. Deliberately does NOT try to merge
// events into every possible React Query cache shape (e.g. GET /state's
// paginated device table -- there's no client-side way to know which page
// an address belongs to without duplicating the backend's sort order);
// instead it invalidates ["stats"] so the aggregate tile refetches from
// the authoritative REST source. See plan/frontend-v2.md Phase 3c: a
// best-effort firehose, not a guaranteed-delivery or fully-synced feed.
export function LiveFeedProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LiveFeedStatus>("connecting");
  const [events, setEvents] = useState<LiveFeedEvent[]>([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    setStatus("connecting");
    const ws = new WebSocket(wsUrl());

    ws.onopen = () => setStatus("open");
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => setStatus("error");
    ws.onmessage = (ev: { data: string }) => {
      let envelope: { channel: string; data: string };
      try {
        envelope = JSON.parse(ev.data);
      } catch {
        return; // not the {channel, data} shape the backend always sends -- skip
      }

      let parsed: DeviceState | null = null;
      try {
        parsed = JSON.parse(envelope.data);
      } catch {
        parsed = null;
      }

      setEvents((prev) =>
        [{ channel: envelope.channel, data: parsed, raw: envelope.data, receivedAt: Date.now() }, ...prev].slice(
          0,
          MAX_EVENTS
        )
      );
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      // events:node:<id> is the only channel that corresponds to a specific
      // Node's aggregate counters (see pingsvc/cmd/pingsvc/main.go's Lua
      // script); the fixed pings:events fallback carries no node id, so
      // there's nothing node-specific to invalidate for it.
      if (envelope.channel.startsWith("events:node:")) {
        queryClient.invalidateQueries({ queryKey: ["node-stats"] });
      }
    };

    const keepalive = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, KEEPALIVE_INTERVAL_MS);

    return () => {
      window.clearInterval(keepalive);
      ws.close();
    };
  }, [queryClient]);

  return <LiveFeedContext.Provider value={{ status, events }}>{children}</LiveFeedContext.Provider>;
}

export function useLiveFeed(): LiveFeedContextValue {
  const ctx = useContext(LiveFeedContext);
  if (!ctx) {
    throw new Error("useLiveFeed must be used within a LiveFeedProvider");
  }
  return ctx;
}
