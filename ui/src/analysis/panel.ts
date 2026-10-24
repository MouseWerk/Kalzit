import type { TargetOutcome } from "../features/dashboards/results";
import { nameFrame } from "../panels/frame";
import { asSteps, type NamedInput, runSteps, type StepsRun } from "./steps";

/**
 * The results steps read, by reference id, in target order: frames, and documents a projection
 * may turn into one. Graphs and failed queries are not inputs.
 */
export function namedInputs(outcomes: readonly TargetOutcome[]): NamedInput[] {
  return outcomes.flatMap((o): NamedInput[] => {
    if (!("result" in o)) return [];
    if (o.result.shape === "frame") return [{ name: o.refId, frame: o.result.frame }];
    if (o.result.shape === "documents") return [{ name: o.refId, documents: o.result.documents }];
    return [];
  });
}

/** A panel's frames after its stored steps (`transformations`); without steps, as answered. */
export function runPanelSteps(
  transformations: readonly unknown[],
  outcomes: readonly TargetOutcome[],
): StepsRun {
  const run = runSteps(asSteps(transformations), namedInputs(outcomes));
  // Panels receive bare frames; the query's reference id stays findable for series names.
  for (const { name, frame } of run.frames) {
    nameFrame(frame, name);
  }
  return run;
}
