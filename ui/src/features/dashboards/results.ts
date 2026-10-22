import type { DocumentSet, Frame, QueryResponse, QueryResult } from "../../api/generated/shapes";
import { projectDocuments, projectionFor } from "../../documents/projection";

/** One target's outcome, in target order, flattened from the response's map by refId. */
export type TargetOutcome =
  | { refId: string; result: QueryResult }
  | {
      refId: string;
      error: { code: string; message: string; reason?: string; params?: Record<string, string> };
    };

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
      return { refId, error: outcome.error };
    }
    return { refId, error: { code: "internal", message: "no result for this query" } };
  });
}

export function framesOf(outcomes: readonly TargetOutcome[]): Frame[] {
  return outcomes.flatMap((o) =>
    "result" in o && o.result.shape === "frame" ? [o.result.frame] : [],
  );
}

/** The document sets of the outcomes with the refId of each, in target order. */
export function documentsOf(
  outcomes: readonly TargetOutcome[],
): { refId: string; documents: DocumentSet }[] {
  return outcomes.flatMap((o) =>
    "result" in o && o.result.shape === "documents"
      ? [{ refId: o.refId, documents: o.result.documents }]
      : [],
  );
}

/**
 * Applies the projection steps among a panel's transformations (documents/projection.ts): the
 * documents of that query become a frame, visibly, because the panel says so. A result that
 * already arrived as a frame, and every query without a step, passes unchanged.
 */
export function projectOutcomes(
  outcomes: readonly TargetOutcome[],
  transformations: readonly unknown[],
): TargetOutcome[] {
  return outcomes.map((outcome) => {
    if (!("result" in outcome) || outcome.result.shape !== "documents") {
      return outcome;
    }
    const projection = projectionFor(transformations, outcome.refId);
    if (projection === undefined || projection.columns.length === 0) {
      return outcome;
    }
    return {
      refId: outcome.refId,
      result: { shape: "frame", frame: projectDocuments(outcome.result.documents, projection) },
    };
  });
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
  return (
    framesOf(outcomes).some((frame) => frame.meta?.rowsTruncated === true) ||
    documentsOf(outcomes).some(({ documents }) => documents.truncated !== undefined)
  );
}
