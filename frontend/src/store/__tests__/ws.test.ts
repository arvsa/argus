import { describe, it, expect, beforeEach } from "vitest";
import { useWsStore, type PingEvent } from "@/store/ws";

function makeEvent(overrides: Partial<PingEvent> = {}): PingEvent {
  return { addr: "10.0.0.1", ok: true, ts: 1000, ...overrides };
}

describe("useWsStore", () => {
  beforeEach(() => {
    useWsStore.getState().reset();
  });

  it("starts disconnected with no events or device states", () => {
    const state = useWsStore.getState();
    expect(state.connected).toBe(false);
    expect(state.events).toEqual([]);
    expect(state.deviceStates).toEqual({});
  });

  it("setConnected toggles the connected flag", () => {
    useWsStore.getState().setConnected(true);
    expect(useWsStore.getState().connected).toBe(true);
    useWsStore.getState().setConnected(false);
    expect(useWsStore.getState().connected).toBe(false);
  });

  it("addEvent prepends to events (most recent first)", () => {
    const first = makeEvent({ addr: "10.0.0.1", ts: 1 });
    const second = makeEvent({ addr: "10.0.0.2", ts: 2 });

    useWsStore.getState().addEvent(first);
    useWsStore.getState().addEvent(second);

    expect(useWsStore.getState().events).toEqual([second, first]);
  });

  it("addEvent indexes the latest state per device address", () => {
    useWsStore.getState().addEvent(makeEvent({ addr: "10.0.0.1", ok: true, ts: 1 }));
    useWsStore.getState().addEvent(makeEvent({ addr: "10.0.0.1", ok: false, ts: 2 }));

    expect(useWsStore.getState().deviceStates["10.0.0.1"]).toEqual(
      makeEvent({ addr: "10.0.0.1", ok: false, ts: 2 })
    );
  });

  it("tracks multiple distinct devices independently", () => {
    useWsStore.getState().addEvent(makeEvent({ addr: "10.0.0.1", ok: true }));
    useWsStore.getState().addEvent(makeEvent({ addr: "10.0.0.2", ok: false }));

    const { deviceStates } = useWsStore.getState();
    expect(deviceStates["10.0.0.1"].ok).toBe(true);
    expect(deviceStates["10.0.0.2"].ok).toBe(false);
  });

  it("caps the events feed at 200 entries, dropping the oldest", () => {
    for (let i = 0; i < 205; i++) {
      useWsStore.getState().addEvent(makeEvent({ addr: `10.0.0.${i}`, ts: i }));
    }
    const { events } = useWsStore.getState();
    expect(events).toHaveLength(200);
    // Most recent (ts 204) first; oldest 5 (ts 0-4) dropped.
    expect(events[0].ts).toBe(204);
    expect(events.at(-1)?.ts).toBe(5);
  });

  it("reset clears connection, events, and device state", () => {
    useWsStore.getState().setConnected(true);
    useWsStore.getState().addEvent(makeEvent());

    useWsStore.getState().reset();

    const state = useWsStore.getState();
    expect(state.connected).toBe(false);
    expect(state.events).toEqual([]);
    expect(state.deviceStates).toEqual({});
  });
});
