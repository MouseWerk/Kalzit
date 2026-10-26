import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import type { QueryOutcome, TimeRange } from "../../api/generated/shapes";
import { dropOlderResults } from "../../api/resultCache";
import type { LiveSpec } from "../../live/client";
import { type LiveView, useLiveSubscription } from "../../live/useLive";
import { useSourceKinds } from "../datasources/useSourceKinds";
import { outcomesOf } from "./results";
import { intervalFor, MAX_DATA_POINTS } from "./timeRange";
import { PANEL_DATA_KEY, type PanelQueryInput, panelRequest } from "./usePanelResults";

/**
 * Puts a live result into a query's cache entry. A request for the same entry still on its way
 * is cancelled first: it ran before the pushed result and would otherwise replace it when it
 * lands.
 */
export async function writeLiveResult(
  client: QueryClient,
  key: QueryKey,
  results: Record<string, QueryOutcome>,
  refIds: readonly string[],
): Promise<void> {
  await client.cancelQueries({ queryKey: key, exact: true });
  client.setQueryData(key, outcomesOf({ results }, refIds));
}

/**
 * A stored panel's live subscription while the dashboard is live and the panel is on screen.
 * Each result goes into the cache entry the panel's query read when the subscription started, so
 * the panel draws it through the same path as a fetched answer; a refresh, a new range or new
 * variables give the panel another entry and start a new subscription for it. `range` is the
 * period of the last result when the range moves with each run (it ends at the run's moment).
 */
export function usePanelLive(
  input: PanelQueryInput,
  visible: boolean,
): LiveView & { range: TimeRange | undefined } {
  const client = useQueryClient();
  const kindOf = useSourceKinds(input.orgId);
  const { orgId, dashboardId, panel, range, source, live } = input;
  const { variables, refIds, queryKey } = panelRequest(input, kindOf);
  // A shifted panel looks at a past period, which does not move with each run.
  const moving = live?.moving === true && panel.timeShift === undefined;
  const length = range.to - range.from;
  const spec: LiveSpec | null =
    live === undefined ||
    live.paused === true ||
    source !== "stored" ||
    !visible ||
    refIds.length === 0 ||
    length <= 0
      ? null
      : {
          panel: { dashboardId, panelId: panel.id },
          ...(moving ? { lastMs: length } : { timeRange: range }),
          variables,
          maxDataPoints: MAX_DATA_POINTS,
          intervalMs: intervalFor(range),
          ...(live.refreshMs === undefined ? {} : { refreshMs: live.refreshMs }),
        };
  const view = useLiveSubscription(orgId, spec, queryKey, (results, _at, key) => {
    void writeLiveResult(client, key, results, refIds).then(() =>
      dropOlderResults(client, [PANEL_DATA_KEY, orgId, dashboardId, panel.id, source], key),
    );
  });
  return {
    ...view,
    range: moving && view.at !== undefined ? { from: view.at - length, to: view.at } : undefined,
  };
}
