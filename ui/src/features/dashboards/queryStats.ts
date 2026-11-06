import type { useI18n } from "../../i18n/i18n";
import { rowCount } from "../../panels/frame";
import type { TargetOutcome } from "./results";

type T = ReturnType<typeof useI18n>["t"];

/**
 * One query's answer in words for the panel editor, as on its board ("96 rows · 42 ms"): rows,
 * documents, or nodes and edges, with the time the server took when it says. Null for an error
 * or no answer yet.
 */
export function queryStats(
  t: T,
  language: string,
  outcome: TargetOutcome | undefined,
): string | null {
  if (outcome === undefined || !("result" in outcome)) {
    return null;
  }
  const n = (value: number) => value.toLocaleString(language);
  const result = outcome.result;
  let size: string;
  if (result.shape === "frame") {
    const rows = rowCount(result.frame);
    size = t(rows === 1 ? "dashboards.editor.size.rowsOne" : "dashboards.editor.size.rowsMany", {
      count: n(rows),
    });
  } else if (result.shape === "documents") {
    const documents = result.documents.documents.length;
    size = t(
      documents === 1
        ? "dashboards.editor.size.documentsOne"
        : "dashboards.editor.size.documentsMany",
      { count: n(documents) },
    );
  } else {
    size = t("dashboards.editor.size.graph", {
      nodes: n(result.graph.nodes.length),
      edges: n(result.graph.edges.length),
    });
  }
  return outcome.elapsedMs === undefined
    ? size
    : t("dashboards.editor.size.timed", { size, ms: n(Math.round(outcome.elapsedMs)) });
}
