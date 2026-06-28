import { create } from "zustand";

export interface PingEvent {
  addr: string;
  state: "up" | "down";
  ts: number;
  room_id?: string;
  bldg_id?: string;
  hostname?: string;
}

interface WsState {
  connected: boolean;
  events: PingEvent[];
  deviceStates: Record<string, PingEvent>;
  setConnected: (v: boolean) => void;
  addEvent: (ev: PingEvent) => void;
  reset: () => void;
}

export const useWsStore = create<WsState>((set) => ({
  connected: false,
  events: [],
  deviceStates: {},
  setConnected: (v) => set({ connected: v }),
  addEvent: (ev) =>
    set((s) => ({
      events: [ev, ...s.events].slice(0, 200),
      deviceStates: { ...s.deviceStates, [ev.addr]: ev },
    })),
  reset: () => set({ connected: false, events: [], deviceStates: {} }),
}));
