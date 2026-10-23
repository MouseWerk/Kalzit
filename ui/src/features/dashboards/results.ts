import type {
  DocumentSet,
  Frame,
  QueryResponse,
  QueryResult,
  Shape,
} from "../../api/generated/shapes";
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
 * The document set of `refId` with the pages loaded after it (`nextCursor`): the documents of
 * all pages in order, the first page's schema, cut and cursor of the last page, and the notices of
 * every page, each once.
 */
export function appendPages(
  outcomes: readonly TargetOutcome[],
  refId: string,
  pages: readonly DocumentSet[],
): TargetOutcome[] {
  const last = pages.at(-1);
  if (last === undefined) {
    return [...outcomes];
  }
  return outcomes.map((outcome) => {
    if (outcome.refId !== refId || !("result" in outcome) || outcome.result.shape !== "documents") {
      return outcome;
    }
    const first = outcome.result.documents;
    // Every page's notices, each said once (pages often repeat the same one).
    const seen = new Set<string>();
    const notices = [first, ...pages].flatMap((page) =>
      page.notices.filter((notice) => {
        const key = JSON.stringify([notice.severity, notice.code, notice.params, notice.text]);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      }),
    );
    const documents: DocumentSet = {
      ...last,
      documents: [...first.documents, ...pages.flatMap((page) => page.documents)],
      schema: first.schema,
      notices,
    };
    return { refId, result: { shape: "documents", documents } };
  });
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
  return (
    framesOf(outcomes).some((frame) => frame.meta?.rowsTruncated === true) ||
    documentsOf(outcomes).some(({ documents }) => documents.truncated !== undefined)
  );
}
