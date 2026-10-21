import type { Frame, QueryResponse, QueryResult } from "../../api/generated/shapes";

/** One target's outcome, in target order, flattened from the response's map by refId. */
export type TargetOutcome =
  | { refId: string; result: QueryResult }
  | { refId: string; error: { code: string; message: string } };

/**
 * Splits a response into results and errors, in the order of the refIds asked for. A refId the
 * server did not answer counts as an internal error, so a panel never silently shows less.
 */
export function outcomesOf(response: QueryResponse, refIds: readonly string[]): TargetOutcome[] {
  return refIds.map((refId) => {
    const outcome = response.results[refId];
    if (outcome !== undefined && "result" in outcome) {
      return { refId, result: outcome.result };
    }
    if (outcome !== undefined && "error" in outcome) {
      return { refId, error: { code: outcome.error.code, message: outcome.error.message } };
    }
    return { refId, error: { code: "internal", message: "no result for this query" } };
  });
}

export function framesOf(outcomes: readonly TargetOutcome[]): Frame[] {
  return outcomes.flatMap((o) =>
    "result" in o && o.result.shape === "frame" ? [o.result.frame] : [],
  );
}

export function errorsOf(outcomes: readonly TargetOutcome[]) {
  return outcomes.flatMap((o) => ("error" in o ? [{ refId: o.refId, ...o.error }] : []));
}

/** Results this panel cannot draw in M1 (documents, graphs): shown as a note, not dropped silently. */
export function otherShapes(outcomes: readonly TargetOutcome[]): string[] {
  return outcomes.flatMap((o) =>
    "result" in o && o.result.shape !== "frame" ? [o.result.shape] : [],
  );
}

export function isTruncated(outcomes: readonly TargetOutcome[]): boolean {
  return framesOf(outcomes).some((frame) => frame.meta?.rowsTruncated === true);
}
