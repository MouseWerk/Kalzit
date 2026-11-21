import { EMPTY_VIEW_STATE, MAX_VIEW_IDS, type PanelViewState } from "../viewState";

/**
 * What a person changed about a graph panel's view without changing its query: the nodes they
 * pinned, where the pinned ones stand, and what they hid (Graph 0.8.1 board, frames 1, 4 and 14).
 * While viewing it is theirs alone and kept on the server (viewState.ts); in the panel editor the
 * pinned nodes and their places are the panel's own (`options.pinned`), saved for everyone.
 * Only ids and places are kept, never properties. Pure, so it is tested without a panel.
 */

/** A place in the drawing's own units. */
export type Place = readonly [number, number];

/** A node pinned with the panel, as its options store it. */
export interface PinnedPlace {
  id: string;
  x: number;
  y: number;
}

export interface ViewEdits {
  /** Pinned node ids, in the order they were pinned. */
  pins: readonly string[];
  /** Where pinned nodes are held; a node pinned without a place (in the table) has none. */
  places: ReadonlyMap<string, Place>;
  /** Hidden node ids and edge ids. */
  hidden: readonly string[];
  hiddenEdges: readonly string[];
  /** Nodes the panel pins that this person released. */
  released: readonly string[];
}

export const NO_EDITS: ViewEdits = {
  pins: [],
  places: new Map(),
  hidden: [],
  hiddenEdges: [],
  released: [],
};

const NO_PANEL_PINS: readonly PinnedPlace[] = [];

/** The edits a kept state stands for. A place without its pin is not kept. */
export function editsFromState(state: PanelViewState): ViewEdits {
  const pinned = new Set(state.pinned);
  return {
    pins: state.pinned,
    places: new Map(
      state.positions.filter((p) => pinned.has(p.id)).map((p) => [p.id, [p.x, p.y] as const]),
    ),
    hidden: state.hidden,
    hiddenEdges: state.hiddenEdges,
    released: state.released,
  };
}

/** The state to keep for these edits and this selection. */
export function stateFromEdits(edits: ViewEdits, selected: readonly string[]): PanelViewState {
  return {
    ...EMPTY_VIEW_STATE,
    pinned: [...edits.pins],
    selected: [...selected],
    positions: edits.pins.flatMap((id) => {
      const at = edits.places.get(id);
      return at === undefined ? [] : [{ id, x: at[0], y: at[1] }];
    }),
    hidden: [...edits.hidden],
    hiddenEdges: [...edits.hiddenEdges],
    released: [...edits.released],
  };
}

/** In the panel editor: the panel's pinned nodes as the edits to work on. */
export function editsFromPanel(panel: readonly PinnedPlace[], session: ViewEdits): ViewEdits {
  return {
    pins: panel.map((p) => p.id),
    places: new Map(panel.map((p) => [p.id, [p.x, p.y] as const])),
    hidden: session.hidden,
    hiddenEdges: session.hiddenEdges,
    released: [],
  };
}

/** In the panel editor: what the panel's options keep of the edits (pinned nodes with a place). */
export function panelFromEdits(edits: ViewEdits): PinnedPlace[] {
  return edits.pins
    .flatMap((id) => {
      const at = edits.places.get(id);
      return at === undefined ? [] : [{ id, x: at[0], y: at[1] }];
    })
    .slice(0, MAX_VIEW_IDS);
}

/** The panel's pinned nodes this person still has: the ones they did not release. */
function standing(edits: ViewEdits, panel: readonly PinnedPlace[]): readonly PinnedPlace[] {
  if (panel.length === 0) return NO_PANEL_PINS;
  const released = new Set(edits.released);
  return panel.filter((p) => !released.has(p.id));
}

/** Every pinned node id: the panel's first, then the person's own, each once. */
export function pinnedIds(edits: ViewEdits, panel: readonly PinnedPlace[]): string[] {
  return [...new Set([...standing(edits, panel).map((p) => p.id), ...edits.pins])];
}

/** Where pinned nodes are held: the panel's places, and over them the person's own. */
export function pinnedPlaces(edits: ViewEdits, panel: readonly PinnedPlace[]): Map<string, Place> {
  const out = new Map<string, Place>();
  for (const p of standing(edits, panel)) out.set(p.id, [p.x, p.y]);
  for (const id of edits.pins) {
    const at = edits.places.get(id);
    if (at !== undefined) out.set(id, at);
  }
  return out;
}

/**
 * The edits with these nodes pinned, each at its place where one is given (a dragged node, or a
 * node pinned where it stands). A node the person had released is theirs again.
 */
export function pin(
  edits: ViewEdits,
  ids: readonly string[],
  places: ReadonlyMap<string, Place> = new Map(),
): ViewEdits {
  const adding = new Set(ids);
  const next = new Map(edits.places);
  for (const id of ids) {
    const at = places.get(id);
    if (at !== undefined) next.set(id, at);
  }
  return {
    ...edits,
    pins: [...new Set([...edits.pins, ...ids])],
    places: next,
    released: edits.released.filter((id) => !adding.has(id)),
  };
}

/** The edits with these nodes released: their own pins gone, the panel's ones marked released. */
export function release(
  edits: ViewEdits,
  ids: readonly string[],
  panel: readonly PinnedPlace[],
): ViewEdits {
  const going = new Set(ids);
  const places = new Map(edits.places);
  for (const id of ids) places.delete(id);
  const ofPanel = panel.filter((p) => going.has(p.id)).map((p) => p.id);
  return {
    ...edits,
    pins: edits.pins.filter((id) => !going.has(id)),
    places,
    released: [...new Set([...edits.released, ...ofPanel])],
  };
}

/** The edits with these nodes and edges hidden as well. */
export function hide(
  edits: ViewEdits,
  nodes: readonly string[],
  edges: readonly string[] = [],
): ViewEdits {
  return {
    ...edits,
    hidden: [...new Set([...edits.hidden, ...nodes])],
    hiddenEdges: [...new Set([...edits.hiddenEdges, ...edges])],
  };
}

/** The edits with these hidden nodes and edges shown again; without ids, all of them. */
export function show(edits: ViewEdits, ids?: readonly string[]): ViewEdits {
  if (ids === undefined) return { ...edits, hidden: [], hiddenEdges: [] };
  const back = new Set(ids);
  return {
    ...edits,
    hidden: edits.hidden.filter((id) => !back.has(id)),
    hiddenEdges: edits.hiddenEdges.filter((id) => !back.has(id)),
  };
}

/** Whether two edits keep the same: nothing to record or to send. */
export function sameEdits(a: ViewEdits, b: ViewEdits): boolean {
  const list = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((id, i) => id === y[i]);
  if (!list(a.pins, b.pins) || !list(a.hidden, b.hidden)) return false;
  if (!list(a.hiddenEdges, b.hiddenEdges) || !list(a.released, b.released)) return false;
  if (a.places.size !== b.places.size) return false;
  for (const [id, at] of a.places) {
    const other = b.places.get(id);
    if (other === undefined || other[0] !== at[0] || other[1] !== at[1]) return false;
  }
  return true;
}

/** How far Alt+arrow moves the focused node or the selection, in px; with Shift the larger step. */
export const NUDGE_PX = 16;
export const NUDGE_BIG_PX = 64;
