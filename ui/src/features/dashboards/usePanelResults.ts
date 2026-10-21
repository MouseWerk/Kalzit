import { useQuery } from "@tanstack/react-query";
import type { TimeRange } from "../../api/generated/shapes";
import { runQuery } from "../datasources/api";
import { queryText } from "../datasources/queryKinds";
import { runPanelQuery } from "./api";
import type { PanelModel } from "./model";
import { panelQueries } from "./queryQueue";
import { outcomesOf, type TargetOutcome } from "./results";
import { intervalFor, MAX_DATA_POINTS } from "./timeRange";

export const PANEL_DATA_KEY = "panel-data";

export interface PanelQueryInput {
  orgId: string;
  dashboardId: string;
  panel: PanelModel;
  range: TimeRange;
  variables: Record<string, string>;
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
  const { orgId, dashboardId, panel, range, variables, source, run } = input;
  const targets = panel.targets.filter(
    (t) => t.datasourceId !== "" && queryText(t.query).trim() !== "",
  );
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
    retry: false,
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
