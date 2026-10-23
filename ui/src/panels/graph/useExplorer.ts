import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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

/**
 * Why nodes cannot be expanded: the source kind has no expand query, the caller may not query
 * the source (or cannot see it at all), or the list of sources is still loading.
 */
export type ExplorerUnavailable = "kind" | "right" | "loading";

export interface Explorer {
  steps: readonly ExplorerStep[];
  /** Why the panel cannot expand nodes, or null when it can. */
  unavailable: ExplorerUnavailable | null;
  /** The node id being expanded, and its caption. */
  pending: string | null;
  pendingCaption: string | null;
  error: string | null;
  expand: (nodeId: string, caption: string) => void;
  undo: () => void;
}

const EXPAND_REF = "expand";

/**
 * Explorer mode: a node's neighbourhood loads with the generic expand query of its source kind
 * (adapter.ts), through the free query route, so it needs `datasources:query` on the source like
 * Explore does. Each expansion is one step on a stack; undo removes the newest, or cancels the
 * one still loading. New base results (a refresh, another source) start over without steps, and
 * a request still running when the panel goes away or the step is undone is cancelled.
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
  const [pending, setPending] = useState<{ nodeId: string; caption: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);

  const datasourceId = graphs[0]?.datasourceId ?? "";
  // The steps belong to the results they expanded; other results start over.
  const [base, setBase] = useState({ datasourceId, graphs: graphs.map((g) => g.graph) });
  if (
    base.datasourceId !== datasourceId ||
    base.graphs.length !== graphs.length ||
    base.graphs.some((graph, i) => graph !== graphs[i]?.graph)
  ) {
    setBase({ datasourceId, graphs: graphs.map((g) => g.graph) });
    setSteps([]);
    setPending(null);
    setError(null);
  }
  // A request for the old results must not add its step to the new ones.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `base` stands for the results
  useEffect(() => () => running.current?.abort(), [base]);

  const source = sources.data?.find((s) => s.id === datasourceId);
  const unavailable: ExplorerUnavailable | null = sources.isPending
    ? "loading"
    : source === undefined
      ? "right"
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
    const controller = new AbortController();
    running.current = controller;
    setPending({ nodeId, caption });
    setError(null);
    try {
      const response = await runQuery(
        orgId,
        {
          queries: [{ refId: EXPAND_REF, datasourceId: source.id, query: request.query }],
          timeRange,
          variables: request.variables,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
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
      if (!controller.signal.aborted) setError(errorMessage(t, failure));
    } finally {
      if (running.current === controller) {
        running.current = null;
        setPending(null);
      }
    }
  }

  return {
    steps,
    unavailable,
    pending: pending?.nodeId ?? null,
    pendingCaption: pending?.caption ?? null,
    error,
    expand: (nodeId, caption) => void expand(nodeId, caption),
    undo: () => {
      setError(null);
      if (running.current !== null) {
        running.current.abort();
        running.current = null;
        setPending(null);
        return;
      }
      setSteps((current) => current.slice(0, -1));
    },
  };
}
