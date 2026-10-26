import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query";
import { asSteps, stepFrames } from "../../analysis/steps";
import type { TimeRange } from "../../api/generated/shapes";
import { dropOlderResults, RESULT_GC_MS } from "../../api/resultCache";
import { BUSY_RETRY } from "../../api/retry";
import { DISTRIBUTION_FRESH_MS } from "../../documents/distributionCache";
import type { DistributionAsk, DistributionSource } from "../../panels/types";
import { fetchDistribution, runQuery } from "../datasources/api";
import { hasQuery, normalizeQuery } from "../datasources/queryKinds";
import { useSourceKinds } from "../datasources/useSourceKinds";
import { fetchPanelDistribution, runPanelQuery } from "./api";
import {
  type PanelModel,
  storedQueryVariables,
  type VariableModel,
  type VariableValues,
} from "./model";
import { panelQueries } from "./queryQueue";
import { outcomesOf, type TargetOutcome } from "./results";
import { intervalFor, MAX_DATA_POINTS } from "./timeRange";

export const PANEL_DATA_KEY = "panel-data";

export interface PanelQueryInput {
  orgId: string;
  dashboardId: string;
  panel: PanelModel;
  range: TimeRange;
  variables: VariableValues;
  /** The saved dashboard's variables, which decide what the panel route may be sent. */
  saved?: readonly VariableModel[];
  /**
   * `stored` runs the saved panel through the panel query route, as every viewer does. `draft`
   * runs the targets being edited through the free query route, which editors may use; the
   * stored panel may not exist yet or still hold the old queries.
   */
  source: "stored" | "draft";
  /** Bumped by "Refresh" so equal ranges run again. */
  run: number;
  /**
   * Bumped only by explicit refreshes (the Refresh button), not by auto refresh: field
   * distributions ask the database again at once for these. Absent: `run`.
   */
  manual?: number;
}

/**
 * The outcomes of one panel's queries. Panels query in parallel through the shared limiter, and
 * a panel that unmounts cancels its query (TanStack Query aborts the signal it handed out).
 */
export function usePanelResults(input: PanelQueryInput) {
  const { orgId, dashboardId, panel, range, source, run } = input;
  const client = useQueryClient();
  const kindOf = useSourceKinds(orgId);
  const variables =
    source === "stored"
      ? storedQueryVariables(input.variables, input.saved ?? [])
      : input.variables;
  // The panel route runs every stored target, empty ones included, and answers each refId; a
  // draft only sends the targets that can run.
  // Hidden targets run in neither case (the server leaves them out of the panel route too),
  // unless an enabled step reads them: the step needs their frame.
  const read = new Set(
    asSteps(panel.transformations).flatMap((s) => (s.disabled === true ? [] : stepFrames(s))),
  );
  const shown = panel.targets.filter((t) => t.hide !== true || read.has(t.refId));
  const targets =
    source === "stored"
      ? shown
      : shown
          .filter((t) => t.datasourceId !== "" && hasQuery(t.query, kindOf(t.datasourceId)))
          .map((t) => ({ ...t, query: normalizeQuery(t.query, kindOf(t.datasourceId)) }));
  const refIds = targets.map((t) => t.refId);
  return useQuery<TargetOutcome[]>({
    queryKey: [
      PANEL_DATA_KEY,
      orgId,
      dashboardId,
      panel.id,
      source,
      range.from,
      range.to,
      variables,
      // The stored panel answers per shown query: hiding one (or the last) is another request.
      source === "draft" ? targets : refIds,
      run,
    ],
    enabled: targets.length > 0,
    // Results belong to one time range; a newer range replaces them instead of serving them old.
    staleTime: Number.POSITIVE_INFINITY,
    // A refresh, a new range or new variables keep the panel's last answer on screen until the
    // new one is there, so charts, table sort, scroll and page survive. Only the same panel's
    // answer is kept (same organization, dashboard, panel and source): another panel's, or a
    // draft's for the stored panel, never stands in. A panel left without a query to run shows
    // that, not its last answer.
    placeholderData: (previous, previousQuery) =>
      targets.length > 0 &&
      samePanel(previousQuery?.queryKey, [orgId, dashboardId, panel.id, source])
        ? previous
        : undefined,
    // Every refresh makes a new answer of up to the response size limit: only the latest one
    // per panel stays (older ones are dropped when it arrives), and briefly once unshown.
    gcTime: RESULT_GC_MS,
    ...BUSY_RETRY,
    queryFn: ({ signal, queryKey }): Promise<TargetOutcome[]> =>
      panelQueries.run(async () => {
        const common = {
          timeRange: range,
          variables,
          maxDataPoints: MAX_DATA_POINTS,
          intervalMs: intervalFor(range),
        };
        const response =
          source === "stored"
            ? await runPanelQuery(orgId, dashboardId, panel.id, { ...common, cursors: {} }, signal)
            : await runQuery(
                orgId,
                {
                  ...common,
                  queries: targets.map((t) => ({
                    refId: t.refId,
                    datasourceId: t.datasourceId,
                    query: t.query,
                  })),
                },
                signal,
              );
        dropOlderResults(client, [PANEL_DATA_KEY, orgId, dashboardId, panel.id, source], queryKey);
        return outcomesOf(response, refIds);
      }, signal),
  });
}

/** The field distribution of a panel target `refId` over its whole result. */
export type TargetDistribution = DistributionSource<string>;

/**
 * The time window as asked: a window that ends within the last minutes is a relative one (`now`)
 * and is known by its length, so the moments an auto refresh resolves it to keep one identity;
 * any other window by its ends.
 */
export function windowIdentity(range: TimeRange, now = Date.now()): string {
  return range.to > now - DISTRIBUTION_FRESH_MS
    ? `last:${range.to - range.from}`
    : `${range.from}:${range.to}`;
}

/**
 * Asks for field distributions the way the panel's queries run: a stored panel through the panel
 * route (all a viewer may), a draft through the free route with the target being edited.
 * `manual` counts explicit refreshes (the Refresh button, a run in the editor).
 */
export function panelDistribution(
  input: Omit<PanelQueryInput, "run"> & { manual: number },
  kindOf: (datasourceId: string) => string | undefined,
): TargetDistribution {
  const { orgId, dashboardId, panel, range, source } = input;
  const variables =
    source === "stored"
      ? storedQueryVariables(input.variables, input.saved ?? [])
      : input.variables;
  const identity = JSON.stringify([
    orgId,
    dashboardId,
    panel.id,
    source,
    panel.targets,
    variables,
    windowIdentity(range),
  ]);
  return { identity, manual: input.manual, run: runPanelDistribution };

  function runPanelDistribution(refId: string, ask: DistributionAsk, signal: AbortSignal) {
    const common = { timeRange: range, intervalMs: intervalFor(range), variables, ...ask };
    if (source === "stored") {
      return fetchPanelDistribution(orgId, dashboardId, panel.id, { refId, ...common }, signal);
    }
    const target = panel.targets.find((t) => t.refId === refId);
    if (target === undefined) {
      return Promise.reject(new Error(`no query ${refId}`));
    }
    const query = normalizeQuery(target.query, kindOf(target.datasourceId));
    return fetchDistribution(
      orgId,
      { datasourceId: target.datasourceId, query, ...common },
      signal,
    );
  }
}

/** Whether a panel query key (`PANEL_DATA_KEY` first) is of the panel `[orgId, dashboardId, panelId, source]`. */
function samePanel(key: readonly unknown[] | undefined, panel: readonly string[]): boolean {
  return key !== undefined && panel.every((part, i) => key[i + 1] === part);
}

/**
 * Whether the panel waits for its first answer. A refetch with an answer on screen is not a
 * load: the panel keeps drawing it and only marks itself busy.
 */
export function firstLoad(results: UseQueryResult<TargetOutcome[]>): boolean {
  return results.isPending && results.fetchStatus !== "idle";
}
