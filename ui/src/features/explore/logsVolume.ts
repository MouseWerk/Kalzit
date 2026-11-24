import { useQuery } from "@tanstack/react-query";
import { RESULT_GC_MS } from "../../api/resultCache";
import { BUSY_RETRY } from "../../api/retry";
import { useI18n } from "../../i18n/i18n";
import type { VolumeAnswer } from "../../logs/LogsView";
import { lokiVolumeQuery, volumeStep } from "../../logs/volume";
import { outcomesOf, type TargetOutcome } from "../dashboards/results";
import { errorBodyMessage, errorMessage } from "../dashboards/ui/errors";
import { runQuery } from "../datasources/api";
import { parseLokiQuery } from "../datasources/queryKinds";

/** The reference of the count query beside the line query; "Inspect" lists it as such. */
export const VOLUME_REF_ID = "volume";
const VOLUME_KEY = "explore-logs-volume";

interface Run {
  datasourceId: string;
  query: unknown;
  from: number;
  to: number;
  run: number;
}

/**
 * The count query of the logs view (board Logs.dc.html, frame 4): for a Loki log query, the lines
 * per level and bar over the whole range, with the same selector and pipeline, built in plain
 * sight and run as a second, read-only query beside the lines. It is not kept in the history:
 * the person ran the line query, the count belongs to the view. Other sources have no count
 * query yet; the volume then counts the loaded lines and says so.
 */
export function useLogsVolume(
  orgId: string,
  run: Run | null,
  kind: string | undefined,
): { answer: VolumeAnswer; outcome: TargetOutcome | undefined } {
  const { t } = useI18n();
  const step = run === null ? 0 : volumeStep(run.to - run.from);
  const count =
    run === null || kind !== "loki" ? null : lokiVolumeQuery(parseLokiQuery(run.query), step);
  const result = useQuery({
    queryKey: [VOLUME_KEY, orgId, run, count],
    enabled: count !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: RESULT_GC_MS,
    ...BUSY_RETRY,
    queryFn: async ({ signal }) => {
      const current = run as Run;
      const response = await runQuery(
        orgId,
        {
          queries: [{ refId: VOLUME_REF_ID, datasourceId: current.datasourceId, query: count }],
          timeRange: { from: current.from, to: current.to },
          maxDataPoints: Math.ceil((current.to - current.from) / step) + 1,
          intervalMs: step,
          variables: {},
        },
        signal,
      );
      return outcomesOf(response, [VOLUME_REF_ID])[0];
    },
  });
  if (count === null) {
    return { answer: { state: "none" }, outcome: undefined };
  }
  if (result.isPending) {
    return { answer: { state: "loading" }, outcome: undefined };
  }
  if (result.isError) {
    return {
      answer: { state: "failed", message: errorMessage(t, result.error) },
      outcome: undefined,
    };
  }
  const outcome = result.data;
  if (outcome === undefined) {
    return { answer: { state: "none" }, outcome: undefined };
  }
  if ("error" in outcome) {
    return { answer: { state: "failed", message: errorBodyMessage(t, outcome.error) }, outcome };
  }
  return outcome.result.shape === "frame"
    ? { answer: { state: "ready", frame: outcome.result.frame }, outcome }
    : { answer: { state: "none" }, outcome };
}
