import { useRef, useState } from "react";
import {
  dropSteps,
  EMPTY_HISTORY,
  type History,
  type HistoryStep,
  moveTo,
  pushStep,
  redoable,
  undoable,
} from "./history";

/**
 * The history of one graph panel's view (history.ts), kept while the panel is on the page. The
 * newest state is also in a ref, so several changes within one event see each other.
 */
export function useHistory() {
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const latest = useRef(history);
  const nextId = useRef(1);
  const set = (next: History) => {
    latest.current = next;
    setHistory(next);
  };
  return {
    history,
    /** The history as of now, also within the event that changed it. */
    now: () => latest.current,
    record(label: string, undo: () => void, redo: () => void, tag?: string) {
      const id = nextId.current++;
      set(pushStep(latest.current, { id, label, at: Date.now(), undo, redo, tag }));
    },
    /** Takes the newest applied step back; null when there is none. */
    undo(): HistoryStep | null {
      const step = undoable(latest.current);
      if (step === null) return null;
      set({ steps: latest.current.steps, done: latest.current.done - 1 });
      step.undo();
      return step;
    },
    /** Applies the step taken back last again; null when there is none. */
    redo(): HistoryStep | null {
      const step = redoable(latest.current);
      if (step === null) return null;
      set({ steps: latest.current.steps, done: latest.current.done + 1 });
      step.redo();
      return step;
    },
    /** Restores the state after the first `done` steps. */
    goTo(done: number) {
      const { history: next, run } = moveTo(latest.current, done);
      set(next);
      for (const { step, way } of run) step[way]();
    },
    drop(gone: (step: HistoryStep) => boolean) {
      const next = dropSteps(latest.current, gone);
      if (next !== latest.current) set(next);
    },
  };
}

export type ViewHistoryState = ReturnType<typeof useHistory>;
