import type { Frame, QueryResponse, QueryResult, Shape } from "../../api/generated/shapes";
import type { PanelGraph } from "../../panels/types";

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

export function errorsOf(outcomes: readonly TargetOutcome[]) {
  return outcomes.flatMap((o) => ("error" in o ? [{ refId: o.refId, ...o.error }] : []));
}

/** Graph results with the data source of their target, for graph panels. */
export function graphsOf(
  outcomes: readonly TargetOutcome[],
  targets: readonly { refId: string; datasourceId: string }[],
): PanelGraph[] {
  return outcomes.flatMap((o) =>
    "result" in o && o.result.shape === "graph"
      ? [
          {
            refId: o.refId,
            datasourceId: targets.find((t) => t.refId === o.refId)?.datasourceId ?? "",
            graph: o.result.graph,
          },
        ]
      : [],
  );
}

/** Results of shapes the panel cannot draw: shown as a note, not dropped silently. */
export function otherShapes(
  outcomes: readonly TargetOutcome[],
  accepted: readonly Shape[] = ["frame"],
): string[] {
  return outcomes.flatMap((o) =>
    "result" in o && !accepted.includes(o.result.shape) ? [o.result.shape] : [],
  );
}

export function isTruncated(outcomes: readonly TargetOutcome[]): boolean {
  return framesOf(outcomes).some((frame) => frame.meta?.rowsTruncated === true);
}
