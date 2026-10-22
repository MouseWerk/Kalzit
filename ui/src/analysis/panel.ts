import type { TargetOutcome } from "../features/dashboards/results";
import { asSteps, type NamedFrame, runSteps, type StepsRun } from "./steps";

/** The frames of the targets that answered with one, by reference id, in target order. */
export function namedFrames(outcomes: readonly TargetOutcome[]): NamedFrame[] {
  return outcomes.flatMap((o) =>
    "result" in o && o.result.shape === "frame" ? [{ name: o.refId, frame: o.result.frame }] : [],
  );
}

/** A panel's frames after its stored steps (`transformations`); without steps, as answered. */
export function runPanelSteps(
  transformations: readonly unknown[],
  outcomes: readonly TargetOutcome[],
): StepsRun {
  const frames = namedFrames(outcomes);
  const steps = asSteps(transformations);
  return steps.length === 0 ? { frames, steps: [] } : runSteps(steps, frames);
}
