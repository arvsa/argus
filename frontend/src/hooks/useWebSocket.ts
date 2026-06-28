import { useEffect, useRef } from "react";
import { useWsStore } from "@/store/ws";
import { useAuthStore } from "@/store/auth";

export function useWebSocket() {
  const { setConnected, addEvent } = useWsStore();
  const token = useAuthStore((s) => s.token);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delay = useRef(1000);

  useEffect(() => {
    if (!token) return;

    function connect() {
      // VITE_WS_BASE overrides the host in dev (e.g. ws://localhost:8000).
      // In production leave it unset; the path is served from the same origin.
      const base =
        (import.meta.env.VITE_WS_BASE as string | undefined) ??
        `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
      const ws = new WebSocket(`${base}/api/v1/ws/pings`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        delay.current = 1000;
      };

      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.addr && ev.ok !== undefined) addEvent(ev);
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        setConnected(false);
        retryRef.current = setTimeout(() => {
          delay.current = Math.min(delay.current * 2, 30000);
          connect();
        }, delay.current);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [token, setConnected, addEvent]);
}
