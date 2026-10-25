import { useMemo } from "react";
import type { TargetOutcome } from "../features/dashboards/results";
import { useI18n } from "../i18n/i18n";
import type { TimeSettings } from "../lib/timeSettings";
import { nameFrame } from "../panels/frame";
import type { Calendar } from "./expr";
import { asSteps, type NamedInput, runSteps, type StepsRun } from "./steps";

/** The browser's own time zone as an IANA name, for a calendar the server can read too. */
function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The calendar calculated fields read times in: the time zone and first day of the week in
 * effect (the open dashboard's, else the user's), the browser's zone when none is chosen.
 */
export function calendarOf(settings: Pick<TimeSettings, "timeZone" | "weekStart">): Calendar {
  return {
    timeZone: settings.timeZone ?? browserZone(),
    weekStart: settings.weekStart ?? "monday",
  };
}

/** `calendarOf` the settings in effect, kept while they stay the same. */
export function useAnalysisCalendar(): Calendar {
  const { timeZone, weekStart } = useI18n();
  return useMemo(() => calendarOf({ timeZone, weekStart }), [timeZone, weekStart]);
}

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

/**
 * A panel's frames after its stored steps (`transformations`); without steps, as answered.
 * Calculated fields read times in `calendar`.
 */
export function runPanelSteps(
  transformations: readonly unknown[],
  outcomes: readonly TargetOutcome[],
  calendar: Calendar,
): StepsRun {
  const run = runSteps(asSteps(transformations), namedInputs(outcomes), { calendar });
  // Panels receive bare frames; the query's reference id stays findable for series names.
  for (const { name, frame } of run.frames) {
    nameFrame(frame, name);
  }
  return run;
}
