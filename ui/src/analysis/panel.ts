import { useMemo } from "react";
import type { TargetOutcome } from "../features/dashboards/results";
import { useI18n } from "../i18n/i18n";
import type { TimeSettings } from "../lib/timeSettings";
import { nameFrame } from "../panels/frame";
import type { Calendar } from "./expr";
import {
  asSteps,
  isGraphStep,
  type NamedInput,
  runSteps,
  type ServerStep,
  type ServerSteps,
  type Step,
  type StepsRun,
} from "./steps";

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
 * The results steps read, by reference id, in target order: frames, documents a projection may
 * turn into one, and graphs the graph steps read. Failed queries are not inputs.
 */
export function namedInputs(outcomes: readonly TargetOutcome[]): NamedInput[] {
  return outcomes.flatMap((o): NamedInput[] => {
    if (!("result" in o)) return [];
    if (o.result.shape === "frame") return [{ name: o.refId, frame: o.result.frame }];
    if (o.result.shape === "documents") return [{ name: o.refId, documents: o.result.documents }];
    return [{ name: o.refId, graph: o.result.graph }];
  });
}

/** Where the server ran the graph steps of `outcomes`, by step id. */
export function serverRan(outcomes: readonly TargetOutcome[]): Map<string, ServerStep> {
  const ran = new Map<string, ServerStep>();
  for (const o of outcomes) {
    if (!("result" in o)) continue;
    for (const place of o.steps ?? []) {
      ran.set(place.id, { ranIn: place.ranIn, error: place.error });
    }
  }
  return ran;
}

/**
 * The enabled graph steps of each query, which run with it (`QueryItem.steps`), by reference id;
 * queries without them are left out.
 */
export function graphStepsByQuery(steps: readonly Step[]): Map<string, Step[]> {
  const out = new Map<string, Step[]>();
  // A step still being filled in (the server would refuse it) ends its query's list there; the
  // browser previews it until it is complete.
  const unfinished = new Set<string>();
  for (const step of steps) {
    if (step.disabled === true || !isGraphStep(step) || unfinished.has(step.frame)) continue;
    if (!complete(step)) {
      unfinished.add(step.frame);
      continue;
    }
    out.set(step.frame, [...(out.get(step.frame) ?? []), step]);
  }
  return out;
}

/** Whether a graph step passes the server's checks of its form (server/src/analysis/mod.rs). */
function complete(step: Step): boolean {
  switch (step.type) {
    case "sharedNeighbours":
      return step.label !== "" && step.via !== "" && step.label !== step.via;
    case "toFrame":
      return step.columns.some((c) => c.path.trim() !== "");
    default:
      return true;
  }
}

/**
 * A panel's frames after its stored steps (`transformations`); without steps, as answered.
 * Calculated fields read times in `calendar`.
 */
export function runPanelSteps(
  transformations: readonly unknown[],
  outcomes: readonly TargetOutcome[],
  calendar: Calendar,
  /**
   * The answers of the queries with their graph steps when `outcomes` are the queries' own
   * results (Explore runs both); without them, `outcomes` are the answers with the steps.
   */
  stepped?: readonly TargetOutcome[],
): StepsRun {
  const server: ServerSteps =
    stepped === undefined
      ? { ran: serverRan(outcomes) }
      : {
          ran: serverRan(stepped),
          results: new Map(namedInputs(stepped).map((input) => [input.name, input])),
        };
  const run = runSteps(asSteps(transformations), namedInputs(outcomes), { calendar, server });
  // Panels receive bare frames; the query's reference id stays findable for series names.
  for (const { name, frame } of run.frames) {
    nameFrame(frame, name);
  }
  return run;
}
