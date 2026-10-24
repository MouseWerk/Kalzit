import { createContext, useContext, useEffect, useId, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

/**
 * The shared cursor of a dashboard: the time under the pointer in one time panel, drawn as a
 * line (and, with "tooltip", the values) in every other time panel. Kalzit draws its own cursor
 * around both chart renderers (uPlot's own cursor is off), so the time is shared here, the way
 * uPlot's cursor sync would share it between plots: the panel under the pointer publishes, every
 * other one reads, all in the same animation frame.
 */
export type SharedCursorMode = "off" | "crosshair" | "tooltip";

interface Shared {
  time: number | null;
  /** The panel that published the time. */
  source: string | null;
}

export interface CrosshairStore {
  mode: SharedCursorMode;
  get: () => Shared;
  /** Queues a change; the panels draw it in the next animation frame, all at once. */
  set: (source: string, time: number | null) => void;
  /** Applies the queued changes now (the frame callback, and tests). */
  flush: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createCrosshair(mode: SharedCursorMode): CrosshairStore {
  let shared: Shared = { time: null, source: null };
  const listeners = new Set<() => void>();
  // Pointer moves come faster than frames; they are applied once per frame, in order.
  let queued: { source: string; time: number | null }[] = [];
  let frame: number | null = null;
  function flush() {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    const before = shared;
    for (const { source, time } of queued) {
      // Leaving a panel clears only what that panel published.
      if (time === null && shared.source !== source) {
        continue;
      }
      shared = { time, source: time === null ? null : source };
    }
    queued = [];
    if (shared.time === before.time && shared.source === before.source) {
      shared = before;
      return;
    }
    // Every panel draws the new time in this frame, together.
    flushSync(() => {
      for (const listener of listeners) {
        listener();
      }
    });
  }
  return {
    mode,
    get: () => shared,
    set(source, time) {
      queued.push({ source, time });
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          flush();
        });
      }
    },
    flush,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const CrosshairContext = createContext<CrosshairStore | null>(null);

const NOTHING: Shared = { time: null, source: null };
const subscribeNothing = () => () => undefined;
const getNothing = () => NOTHING;

/**
 * The shared cursor for one chart: the time another panel points at (null when none, or when
 * the dashboard does not share its cursor), and `publish` for this chart's own pointer.
 */
export function useSharedCursor(): {
  mode: SharedCursorMode;
  /** The time under the pointer in another panel. */
  time: number | null;
  publish: (time: number | null) => void;
} {
  const store = useContext(CrosshairContext);
  const id = useId();
  const active = store !== null && store.mode !== "off";
  const shared = useSyncExternalStore(
    active ? store.subscribe : subscribeNothing,
    active ? store.get : getNothing,
    getNothing,
  );
  // A panel that goes away (a row folded, the dashboard left) takes its time with it.
  useEffect(() => {
    if (!active) {
      return;
    }
    return () => store.set(id, null);
  }, [active, store, id]);
  return {
    mode: active ? store.mode : "off",
    time: shared.source === id ? null : shared.time,
    publish: (time) => {
      if (active) {
        store.set(id, time);
      }
    },
  };
}
