/**
 * The history of a graph panel's view (Graph 0.8.1 board, frame 6): moving and pinning nodes,
 * hiding and showing, "show only the selection", explorer steps, opened groups and, from the
 * layout and style tools, their own changes. Zoom, the visible part, the selection, hovering and
 * the search are not part of it. A step knows how to take itself back and how to apply itself
 * again; the list is pure, so it is tested without a panel.
 */

/** Steps kept per panel; the oldest goes when another one comes. */
export const HISTORY_LIMIT = 50;

export interface HistoryStep {
  /** Unique within the panel, for keys. */
  id: number;
  /** The step in plain language: "Node moved: Mira Schulz". */
  label: string;
  /** When it happened (Unix milliseconds), for "40 s ago". */
  at: number;
  undo: () => void;
  redo: () => void;
  /**
   * What the step belongs to, for steps that can go away on their own: an explorer step taken
   * back in the step bar leaves the history as well (`explorer:<id>`).
   */
  tag?: string | undefined;
}

export interface History {
  /** Oldest first. */
  steps: readonly HistoryStep[];
  /** How many of the steps are applied: `steps[done - 1]` is the state of the view. */
  done: number;
}

export const EMPTY_HISTORY: History = { steps: [], done: 0 };

/** A new step after the applied ones: steps taken back before it are gone, the oldest beyond the limit too. */
export function pushStep(history: History, step: HistoryStep, limit = HISTORY_LIMIT): History {
  const steps = [...history.steps.slice(0, history.done), step];
  const kept = steps.slice(Math.max(0, steps.length - limit));
  return { steps: kept, done: kept.length };
}

/** The step "undo" takes back, or null when nothing is applied. */
export function undoable(history: History): HistoryStep | null {
  return history.steps[history.done - 1] ?? null;
}

/** The step "redo" applies again, or null when none was taken back. */
export function redoable(history: History): HistoryStep | null {
  return history.steps[history.done] ?? null;
}

/**
 * What it takes to have exactly `done` steps applied: the steps to take back (newest first) or
 * to apply again (oldest first). The caller runs them and keeps the returned history.
 */
export function moveTo(
  history: History,
  done: number,
): { history: History; run: { step: HistoryStep; way: "undo" | "redo" }[] } {
  const target = Math.min(history.steps.length, Math.max(0, Math.round(done)));
  const run: { step: HistoryStep; way: "undo" | "redo" }[] = [];
  for (let i = history.done - 1; i >= target; i--) {
    run.push({ step: history.steps[i] as HistoryStep, way: "undo" });
  }
  for (let i = history.done; i < target; i++) {
    run.push({ step: history.steps[i] as HistoryStep, way: "redo" });
  }
  return { history: { steps: history.steps, done: target }, run };
}

/** The history without the steps `gone` names; the applied count follows. */
export function dropSteps(history: History, gone: (step: HistoryStep) => boolean): History {
  let done = history.done;
  const steps = history.steps.filter((step, i) => {
    if (!gone(step)) return true;
    if (i < history.done) done--;
    return false;
  });
  return steps.length === history.steps.length ? history : { steps, done };
}
