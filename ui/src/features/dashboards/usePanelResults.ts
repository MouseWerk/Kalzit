import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { asSteps, stepFrames } from "../../analysis/steps";
import type { TimeRange } from "../../api/generated/shapes";
import { BUSY_RETRY } from "../../api/retry";
import { runQuery } from "../datasources/api";
import { hasQuery, normalizeQuery } from "../datasources/queryKinds";
import { useSourceKinds } from "../datasources/useSourceKinds";
import { runPanelQuery } from "./api";
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
}

/**
 * The outcomes of one panel's queries. Panels query in parallel through the shared limiter, and
 * a panel that unmounts cancels its query (TanStack Query aborts the signal it handed out).
 */
export function usePanelResults(input: PanelQueryInput) {
  const { orgId, dashboardId, panel, range, source, run } = input;
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
    gcTime: 60_000,
    ...BUSY_RETRY,
    queryFn: ({ signal }): Promise<TargetOutcome[]> =>
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
        return outcomesOf(response, refIds);
      }, signal),
  });
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
