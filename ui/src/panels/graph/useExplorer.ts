import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { GraphSet, TimeRange } from "../../api/generated/shapes";
import { errorBodyMessage, errorMessage } from "../../features/dashboards/ui/errors";
import { datasourcesQuery, runQuery, sourceAccess } from "../../features/datasources/api";
import { useI18n } from "../../i18n/i18n";
import { useOrgPermissions } from "../../org/useOrg";
import type { PanelGraph } from "../types";
import { expandQuery } from "./adapter";

/** One expansion: the neighbourhood loaded for a node, undone as a whole. */
export interface ExplorerStep {
  nodeId: string;
  caption: string;
  graph: GraphSet;
}

export type ExplorerUnavailable = "kind" | "right" | "source";

export interface Explorer {
  steps: readonly ExplorerStep[];
  /** Why the panel cannot expand nodes, or null when it can. */
  unavailable: ExplorerUnavailable | null;
  /** The node id being expanded. */
  pending: string | null;
  error: string | null;
  expand: (nodeId: string, caption: string) => void;
  undo: () => void;
}

const EXPAND_REF = "expand";

/**
 * Explorer mode: a node's neighbourhood loads with the generic expand query of its source kind
 * (adapter.ts), through the free query route, so it needs `datasources:query` on the source like
 * Explore does. Each expansion is one step on a stack; undo removes the newest.
 */
export function useExplorer(
  orgId: string,
  graphs: readonly PanelGraph[],
  timeRange: TimeRange,
  limit: number,
): Explorer {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const sources = useQuery(datasourcesQuery(orgId));
  const [steps, setSteps] = useState<ExplorerStep[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const datasourceId = graphs[0]?.datasourceId ?? "";
  const source = sources.data?.find((s) => s.id === datasourceId);
  const unavailable: ExplorerUnavailable | null =
    source === undefined
      ? "source"
      : !sourceAccess(source.access, permissions).query
        ? "right"
        : expandQuery(source.kind, "", 1) === null
          ? "kind"
          : null;

  async function expand(nodeId: string, caption: string) {
    if (source === undefined || unavailable !== null || pending !== null) {
      return;
    }
    const request = expandQuery(source.kind, nodeId, limit);
    if (request === null) {
      return;
    }
    setPending(nodeId);
    setError(null);
    try {
      const response = await runQuery(orgId, {
        queries: [{ refId: EXPAND_REF, datasourceId: source.id, query: request.query }],
        timeRange,
        variables: request.variables,
      });
      const outcome = response.results[EXPAND_REF];
      if (outcome === undefined) {
        setError(t("errors.internal"));
      } else if ("error" in outcome) {
        setError(errorBodyMessage(t, outcome.error));
      } else if (outcome.result.shape !== "graph") {
        setError(t("graph.explorer.notGraph"));
      } else {
        const graph = outcome.result.graph;
        setSteps((current) => [...current, { nodeId, caption, graph }]);
      }
    } catch (failure) {
      setError(errorMessage(t, failure));
    } finally {
      setPending(null);
    }
  }

  return {
    steps,
    unavailable,
    pending,
    error,
    expand: (nodeId, caption) => void expand(nodeId, caption),
    undo: () => {
      setError(null);
      setSteps((current) => current.slice(0, -1));
    },
  };
}
