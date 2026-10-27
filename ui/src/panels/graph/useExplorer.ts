import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { GraphSet, QueryOutcome, TimeRange } from "../../api/generated/shapes";
import { errorBodyMessage, errorMessage } from "../../features/dashboards/ui/errors";
import { datasourcesQuery, runQuery, sourceAccess } from "../../features/datasources/api";
import { useI18n } from "../../i18n/i18n";
import { useOrgPermissions } from "../../org/useOrg";
import type { PanelGraph } from "../types";
import {
  canExplore,
  countQuery,
  type Direction,
  type ExpandQuery,
  expandQuery,
  frameNumber,
  MAX_EXPAND_LIMIT,
  nodesQuery,
} from "./adapter";

/** What the next step loads: how many neighbours, along which edge types, in which direction. */
export interface StepSettings {
  limit: number;
  /** Edge types to follow; empty follows every type. */
  types: readonly string[];
  direction: Direction;
}

/** One step: neighbours loaded for a node, taken back as a whole. */
export interface ExplorerStep {
  /** Unique for the panel's results, for keys and announcements. */
  id: number;
  nodeId: string;
  caption: string;
  graph: GraphSet;
  /** Neighbours this step answered with (not counting the node itself). */
  loaded: number;
  /** Neighbours of the node before this step (the `skip` of "load more"). */
  skipped: number;
  /** How many neighbours the node has along the step's edges, or null when unknown. */
  total: number | null;
  settings: StepSettings;
}

/**
 * Why nodes cannot be expanded: the source kind has no expand query (TigerGraph), the caller may
 * not query the source (or cannot see it at all), or the list of sources is still loading.
 */
export type ExplorerUnavailable = "kind" | "right" | "loading";

export interface Explorer {
  steps: readonly ExplorerStep[];
  /** Why the panel cannot expand nodes, or null when it can. */
  unavailable: ExplorerUnavailable | null;
  /** The source's kind, for queries made from the exploration ("" while unknown). */
  kind: string;
  datasourceId: string;
  /** The step still loading. */
  pending: { nodeId: string; caption: string } | null;
  error: string | null;
  settings: StepSettings;
  setSettings: (settings: StepSettings) => void;
  /** Loads the neighbours of a node with the current settings. */
  expand: (nodeId: string, caption: string) => void;
  /** Loads the next neighbours of the node of `step`, with that step's settings. */
  more: (step: ExplorerStep) => void;
  /** Stops the step still loading. */
  cancel: () => void;
  /** Takes back the newest step, or stops the one still loading. */
  undo: () => void;
  /** Keeps the first `count` steps and takes back the others (0: back to the query's result). */
  backTo: (count: number) => void;
  /** Nodes fetched by id (pins kept from an earlier visit), drawn with the steps. */
  restored: GraphSet | null;
  restore: (ids: readonly string[]) => void;
}

type StepError = Extract<QueryOutcome, { error: unknown }>["error"];

const EXPAND_REF = "expand";
const COUNT_REF = "count";

/** A step's answer, or the reason it failed. */
function readStep(
  outcome: QueryOutcome | undefined,
): { graph: GraphSet } | { error: StepError | null } | { notGraph: true } {
  if (outcome === undefined) return { error: null };
  if ("error" in outcome) return { error: outcome.error };
  if (outcome.result.shape !== "graph") return { notGraph: true };
  return { graph: outcome.result.graph };
}

/**
 * Explorer mode: a node's neighbourhood loads with the generic queries of its source kind
 * (adapter.ts), through the free query route, so it needs `datasources:query` on the source like
 * Explore does. Each load is one step: the steps can be taken back one by one, or all after a
 * chosen one; a step still loading can be stopped. Limit, edge types and direction apply to the
 * next step. New base results (a refresh, another source) start over without steps, and a
 * request still running when the panel goes away or the step is taken back is cancelled.
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
  const [settings, setSettings] = useState<StepSettings>({
    limit: Math.min(MAX_EXPAND_LIMIT, Math.max(1, limit)),
    types: [],
    direction: "both",
  });
  const [restored, setRestored] = useState<GraphSet | null>(null);
  const running = useRef<AbortController | null>(null);
  const nextId = useRef(1);

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
      : !canExplore(source.kind)
        ? "kind"
        : !sourceAccess(source.access, permissions).query
          ? "right"
          : null;

  async function run(
    requests: { refId: string; request: ExpandQuery }[],
    controller: AbortController,
  ) {
    // Each query brings its own variables; they share one request, so their names differ.
    const variables = Object.assign({}, ...requests.map((r) => r.request.variables));
    return runQuery(
      orgId,
      {
        queries: requests.map((r) => ({
          refId: r.refId,
          datasourceId: (source as { id: string }).id,
          query: r.request.query,
        })),
        timeRange,
        variables,
      },
      controller.signal,
    );
  }

  async function load(nodeId: string, caption: string, step: StepSettings, skipped: number) {
    if (source === undefined || unavailable !== null || pending !== null) {
      return;
    }
    const request = expandQuery(source.kind, nodeId, { ...step, skip: skipped });
    const count = countQuery(source.kind, nodeId, step);
    if (request === null || count === null) {
      return;
    }
    const controller = new AbortController();
    running.current = controller;
    setPending({ nodeId, caption });
    setError(null);
    try {
      const response = await run(
        [
          { refId: EXPAND_REF, request },
          { refId: COUNT_REF, request: count },
        ],
        controller,
      );
      if (controller.signal.aborted) return;
      const answer = readStep(response.results[EXPAND_REF]);
      if ("error" in answer) {
        setError(answer.error === null ? t("errors.internal") : errorBodyMessage(t, answer.error));
      } else if ("notGraph" in answer) {
        setError(t("graph.explorer.notGraph"));
      } else {
        const counted = response.results[COUNT_REF];
        const total =
          counted !== undefined && "result" in counted && counted.result.shape === "frame"
            ? frameNumber(counted.result.frame)
            : null;
        const loaded = answer.graph.nodes.filter((n) => n.id !== nodeId).length;
        const id = nextId.current++;
        setSteps((current) => [
          ...current,
          { id, nodeId, caption, graph: answer.graph, loaded, skipped, total, settings: step },
        ]);
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

  function cancel() {
    setError(null);
    running.current?.abort();
    running.current = null;
    setPending(null);
  }

  async function restore(ids: readonly string[]) {
    if (source === undefined || unavailable !== null || ids.length === 0) return;
    const request = nodesQuery(source.kind, ids);
    if (request === null) return;
    try {
      const response = await run([{ refId: EXPAND_REF, request }], new AbortController());
      const answer = readStep(response.results[EXPAND_REF]);
      if ("graph" in answer) setRestored(answer.graph);
    } catch {
      // Pins that cannot be fetched again stay kept, just not drawn.
    }
  }

  return {
    steps,
    unavailable,
    kind: source?.kind ?? "",
    datasourceId,
    pending,
    error,
    settings,
    setSettings,
    expand: (nodeId, caption) => void load(nodeId, caption, settings, 0),
    more: (step) => void load(step.nodeId, step.caption, step.settings, step.skipped + step.loaded),
    cancel,
    undo: () => {
      if (running.current !== null) {
        cancel();
        return;
      }
      setError(null);
      setSteps((current) => current.slice(0, -1));
    },
    backTo: (count) => {
      cancel();
      setSteps((current) => current.slice(0, Math.max(0, count)));
    },
    restored,
    restore: (ids) => void restore(ids),
  };
}
