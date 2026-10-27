import { useEffect, useRef, useState } from "react";
import { isRecord } from "../../api/client";
import { orgPath, send } from "../../features/datasources/api";

/**
 * A viewer's own state of a graph panel on a dashboard, kept on the server for them alone
 * (docs/api/dashboard-features.md, "Panel view state"): the ids of the nodes they pinned and
 * selected. It changes neither the panel nor its query.
 */
export interface PanelViewState {
  pinned: string[];
  selected: string[];
}

/** Ids per list, as the server keeps them (`MAX_IDS`). */
export const MAX_VIEW_IDS = 200;
/** Longest node id the server keeps (`MAX_ID_CHARS`); longer ones are not kept. */
export const MAX_ID_CHARS = 512;
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

export async function fetchViewState(
  orgId: string,
  view: PanelView,
  signal?: AbortSignal,
): Promise<PanelViewState> {
  const body = await send("GET", viewPath(orgId, view), undefined, signal);
  return isRecord(body)
    ? { pinned: ids(body.pinned), selected: ids(body.selected) }
    : { pinned: [], selected: [] };
}

export async function saveViewState(
  orgId: string,
  view: PanelView,
  state: PanelViewState,
): Promise<void> {
  await send("PUT", viewPath(orgId, view), {
    pinned: keepable(state.pinned),
    selected: keepable(state.selected),
  });
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
    const text = JSON.stringify(state);
    // What was read, or sent last, needs no request.
    if (text === (last.current ?? JSON.stringify(read.state))) return;
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
