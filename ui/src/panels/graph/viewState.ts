import { useEffect, useRef, useState } from "react";
import { isRecord } from "../../api/client";
import { orgPath, send } from "../../features/datasources/api";

/** Where a pinned node was dragged to, in the drawing's own units. */
export interface KeptPosition {
  id: string;
  x: number;
  y: number;
}

/**
 * A viewer's own state of a graph panel on a dashboard, kept on the server for them alone
 * (docs/api/dashboard-features.md, "Panel view state"): the ids of the nodes they pinned and
 * selected, where they dragged pinned nodes to, the nodes and edges they hid, and the panel's own
 * pinned nodes they released. It changes neither the panel nor its query.
 */
export interface PanelViewState {
  pinned: string[];
  selected: string[];
  positions: KeptPosition[];
  hidden: string[];
  hiddenEdges: string[];
  released: string[];
}

export const EMPTY_VIEW_STATE: PanelViewState = {
  pinned: [],
  selected: [],
  positions: [],
  hidden: [],
  hiddenEdges: [],
  released: [],
};

/** Ids per list, as the server keeps them (`MAX_IDS`). */
export const MAX_VIEW_IDS = 200;
/** Longest node id the server keeps (`MAX_ID_CHARS`); longer ones are not kept. */
export const MAX_ID_CHARS = 512;
/** Largest coordinate the server keeps, either way from zero (`MAX_COORDINATE`). */
export const MAX_COORDINATE = 1e9;
/** A change is sent once the viewer pauses this long, not on every click. */
export const SAVE_DELAY_MS = 600;

export interface PanelView {
  dashboardId: string;
  panelId: string;
}

function viewPath(orgId: string, view: PanelView): string {
  return orgPath(orgId, "dashboards", view.dashboardId, "panels", view.panelId, "view-state");
}

/** Ids as the server keeps them: text of 1 to MAX_ID_CHARS characters, each once, at most MAX_VIEW_IDS. */
function keepable(list: readonly unknown[]): string[] {
  return [
    ...new Set(
      list.filter(
        (v): v is string => typeof v === "string" && v.length > 0 && [...v].length <= MAX_ID_CHARS,
      ),
    ),
  ].slice(0, MAX_VIEW_IDS);
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? keepable(value) : [];
}

function coordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

/**
 * Positions as the server keeps them: one per id, with an id it keeps and finite coordinates, at
 * most MAX_VIEW_IDS; coordinates rounded to hundredths, which is finer than a pixel at any zoom.
 */
export function keepablePositions(list: readonly unknown[]): KeptPosition[] {
  const out: KeptPosition[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (out.length >= MAX_VIEW_IDS) break;
    if (!isRecord(entry)) continue;
    const { id, x, y } = entry;
    if (typeof id !== "string" || id.length === 0 || [...id].length > MAX_ID_CHARS) continue;
    if (seen.has(id) || !coordinate(x) || !coordinate(y)) continue;
    seen.add(id);
    out.push({ id, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  }
  return out;
}

/** A state read from the server (or anything else): every list within the server's bounds. */
export function readViewState(body: unknown): PanelViewState {
  if (!isRecord(body)) return EMPTY_VIEW_STATE;
  return {
    pinned: ids(body.pinned),
    selected: ids(body.selected),
    positions: Array.isArray(body.positions) ? keepablePositions(body.positions) : [],
    hidden: ids(body.hidden),
    hiddenEdges: ids(body.hiddenEdges),
    released: ids(body.released),
  };
}

/**
 * The state as it is sent: the lists added in 0.8.1 only while they hold something, as the server
 * answers them, so a state without them is the two lists it always was.
 */
export function writeViewState(state: PanelViewState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    pinned: keepable(state.pinned),
    selected: keepable(state.selected),
  };
  const positions = keepablePositions(state.positions);
  if (positions.length > 0) body.positions = positions;
  for (const name of ["hidden", "hiddenEdges", "released"] as const) {
    const list = keepable(state[name]);
    if (list.length > 0) body[name] = list;
  }
  return body;
}

export async function fetchViewState(
  orgId: string,
  view: PanelView,
  signal?: AbortSignal,
): Promise<PanelViewState> {
  return readViewState(await send("GET", viewPath(orgId, view), undefined, signal));
}

export async function saveViewState(
  orgId: string,
  view: PanelView,
  state: PanelViewState,
): Promise<void> {
  await send("PUT", viewPath(orgId, view), writeViewState(state));
}

/** Forgets the caller's state of the panel ("Back to the panel's state"). */
export async function deleteViewState(orgId: string, view: PanelView): Promise<void> {
  await send("DELETE", viewPath(orgId, view));
}

/**
 * The kept state of the panel (null until it is read, and where there is nowhere to keep it),
 * and `keep`, which sends a new state after a short pause. A state that cannot be read or kept
 * (an unsaved panel, a lost connection) is simply not kept: it is a convenience, never a reason
 * to interrupt the viewer.
 */
export function usePanelViewState(orgId: string | undefined, view: PanelView | undefined) {
  const enabled = orgId !== undefined && view !== undefined;
  const dashboardId = view?.dashboardId;
  const panelId = view?.panelId;
  const [read, setRead] = useState<{ state: PanelViewState | null; done: boolean }>({
    state: null,
    done: !enabled,
  });
  useEffect(() => {
    if (orgId === undefined || dashboardId === undefined || panelId === undefined) return;
    const controller = new AbortController();
    fetchViewState(orgId, { dashboardId, panelId }, controller.signal).then(
      (state) => setRead({ state, done: true }),
      () => {
        if (!controller.signal.aborted) setRead({ state: null, done: true });
      },
    );
    return () => controller.abort();
  }, [orgId, dashboardId, panelId]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef<string | null>(null);
  // The state waiting for its pause, sent at once when the panel goes away.
  const waiting = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      waiting.current?.();
      waiting.current = null;
    },
    [],
  );
  function keep(state: PanelViewState) {
    if (orgId === undefined || dashboardId === undefined || panelId === undefined) return;
    if (read.state === null) return;
    const text = JSON.stringify(writeViewState(state));
    // What was read, or sent last, needs no request.
    if (text === (last.current ?? JSON.stringify(writeViewState(read.state)))) return;
    last.current = text;
    if (timer.current !== null) clearTimeout(timer.current);
    const send = () => {
      void saveViewState(orgId, { dashboardId, panelId }, state).catch(() => undefined);
    };
    waiting.current = send;
    timer.current = setTimeout(() => {
      timer.current = null;
      waiting.current = null;
      send();
    }, SAVE_DELAY_MS);
  }
  return {
    /** The kept state once read; null while reading, without a place, or when reading failed. */
    state: read.state,
    /** Whether reading is over (or there is nothing to read), so the panel may start keeping. */
    settled: read.done,
    keep,
  };
}
