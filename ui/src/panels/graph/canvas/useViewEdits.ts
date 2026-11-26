import { useMemo, useRef, useState } from "react";
import type { PanelViewState } from "../viewState";
import {
  editsFromPanel,
  editsFromState,
  mergeEdits,
  NO_EDITS,
  type PinnedPlace,
  panelFromEdits,
  pinnedIds,
  pinnedPlaces,
  sameEdits,
  samePlaces,
  type ViewEdits,
} from "./edits";

/**
 * The edits of a graph panel's view (edits.ts) and where they are kept (Graph 0.8.1 board, frame
 * 14, decision 4): while viewing, the person's own, which the panel sends to its view state on
 * the server; in the panel editor (`editOptions`), pinned nodes and their places are the panel's
 * options, saved with the dashboard for everyone, and hiding stays with this session. Every
 * change is a step of the view's history.
 */
export function useViewEdits({
  panel,
  editOptions,
  record,
}: {
  /** The panel's own pinned nodes (`options.pinned`). */
  panel: readonly PinnedPlace[];
  /** In the panel editor: writes the panel's pinned nodes. Absent while viewing. */
  editOptions: ((pinned: PinnedPlace[]) => void) | undefined;
  record: (label: string, undo: () => void, redo: () => void) => void;
}) {
  const [own, setOwn] = useState<ViewEdits>(NO_EDITS);
  const editing = editOptions !== undefined;
  const edits = useMemo(() => (editing ? editsFromPanel(panel, own) : own), [editing, panel, own]);
  // The newest edits and the way to apply them, for changes within one event and for the steps
  // of the history, which run long after they were recorded.
  const latest = useRef(edits);
  latest.current = edits;
  const write = useRef<(next: ViewEdits) => void>(() => undefined);
  write.current = (next: ViewEdits) => {
    latest.current = next;
    if (editOptions !== undefined) {
      const pins = panelFromEdits(next);
      editOptions(pins);
      setOwn((current) => ({ ...current, hidden: next.hidden, hiddenEdges: next.hiddenEdges }));
    } else {
      setOwn(next);
    }
  };
  // The pinned ids and places keep their identity while their entries stay the same (hiding and
  // showing change neither), so the canvas does not place 20,000 nodes again for nothing.
  const ids = useStable(
    useMemo(() => (editing ? [...edits.pins] : pinnedIds(edits, panel)), [editing, edits, panel]),
    sameList,
  );
  const places = useStable(
    useMemo(
      () => (editing ? new Map(edits.places) : pinnedPlaces(edits, panel)),
      [editing, edits, panel],
    ),
    samePlaces,
  );
  return {
    edits,
    /** Every pinned node id: the panel's (unless released) and the person's own. */
    ids,
    /** Where pinned nodes are held, by node id. */
    places,
    /** The edits as of now, also within the event that changed them. */
    now: () => latest.current,
    /**
     * Applies `next` as one step of the history, named `label`; nothing happens when it keeps
     * the same. Returns whether it changed anything.
     */
    change(next: ViewEdits, label: string): boolean {
      const before = latest.current;
      if (sameEdits(before, next)) return false;
      write.current(next);
      record(
        label,
        () => write.current(before),
        () => write.current(next),
      );
      return true;
    },
    /**
     * The person's kept state, read once from the server; not a step of the history. What they
     * changed before it arrived stays on top of it (mergeEdits).
     */
    restore(state: PanelViewState) {
      const next = mergeEdits(editsFromState(state), latest.current);
      latest.current = editing ? editsFromPanel(panel, next) : next;
      setOwn(next);
    },
  };
}

export type ViewEditsState = ReturnType<typeof useViewEdits>;

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The previous value while `same` says the new one holds the same. */
function useStable<T>(value: T, same: (a: T, b: T) => boolean): T {
  const kept = useRef(value);
  if (kept.current !== value && !same(kept.current, value)) kept.current = value;
  return kept.current;
}
