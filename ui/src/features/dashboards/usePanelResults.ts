import { useQuery } from "@tanstack/react-query";
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
  const targets =
    source === "stored"
      ? panel.targets
      : panel.targets
          .filter((t) => t.datasourceId !== "" && hasQuery(t.query, kindOf(t.datasourceId)))
          .map((t) => ({ ...t, query: normalizeQuery(t.query, kindOf(t.datasourceId)) }));
  const refIds = targets.map((t) => t.refId);
  return useQuery({
    queryKey: [
      PANEL_DATA_KEY,
      orgId,
      dashboardId,
      panel.id,
      source,
      range.from,
      range.to,
      variables,
      source === "draft" ? targets : null,
      run,
    ],
    enabled: targets.length > 0,
    // Results belong to one time range; a newer range replaces them instead of serving them old.
    staleTime: Number.POSITIVE_INFINITY,
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
