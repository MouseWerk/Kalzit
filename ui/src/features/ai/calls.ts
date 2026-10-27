import { isRecord, requestStream, type StreamEvent } from "../../api/client";
import type { AiStatus, TimeRange } from "../../api/generated/shapes";
import type { Reason } from "../datasources/reasons";

/**
 * The plain AI calls of docs/api/ai.md ("Explain, draft and summarize"): explain a query, draft
 * one, summarize a result of Explore or a dashboard panel. Answers arrive as server-sent events.
 */
export type AiCallRequest =
  | { kind: "explain"; datasourceId: string; query: unknown }
  | { kind: "draft"; datasourceId: string; request: string; query: unknown }
  | {
      kind: "summarize";
      query: { refId: string; datasourceId: string; query: unknown };
      timeRange: TimeRange;
      intervalMs?: number;
    }
  | {
      kind: "summarizePanel";
      dashboardId: string;
      panelId: string;
      timeRange: TimeRange;
      variables: Record<string, unknown>;
      intervalMs?: number;
    };

/** Who answered, as the `meta` event names it. */
export interface AiCallProvider {
  name: string;
  kind: string;
  model: string;
  host: string;
}

export interface AiSentResult {
  refId: string;
  rows: number;
  truncated: boolean;
  excludedValues: number;
}

/** What was sent: the schema (explain, draft) or the results (summarize). */
export interface AiCallMeta {
  provider?: AiCallProvider;
  schema?: boolean;
  results?: AiSentResult[];
  title?: boolean;
}

export interface AiCallDone {
  usage?: { inputTokens: number; outputTokens: number };
  /** The drafted query in the source's query form; `null` when the answer does not fit it. */
  draft?: unknown;
  draftText?: string;
}

function org(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}`;
}

/** The path and body of a call, in the person's UI language. */
export function callRoute(
  orgId: string,
  call: AiCallRequest,
  language: string,
): { path: string; body: Record<string, unknown> } {
  const lang = language === "de" ? "de" : "en";
  switch (call.kind) {
    case "explain":
      return {
        path: `${org(orgId)}/ai/explain`,
        body: { datasourceId: call.datasourceId, query: call.query, language: lang },
      };
    case "draft":
      return {
        path: `${org(orgId)}/ai/draft`,
        body: {
          datasourceId: call.datasourceId,
          request: call.request,
          query: call.query,
          language: lang,
        },
      };
    case "summarize":
      return {
        path: `${org(orgId)}/ai/summarize`,
        body: {
          query: call.query,
          timeRange: call.timeRange,
          ...(call.intervalMs === undefined ? {} : { intervalMs: call.intervalMs }),
          language: lang,
        },
      };
    case "summarizePanel":
      return {
        path: `${org(orgId)}/dashboards/${encodeURIComponent(call.dashboardId)}/panels/${encodeURIComponent(call.panelId)}/ai/summarize`,
        body: {
          timeRange: call.timeRange,
          variables: call.variables,
          ...(call.intervalMs === undefined ? {} : { intervalMs: call.intervalMs }),
          language: lang,
        },
      };
  }
}

export interface AiCallHandlers {
  onMeta: (meta: AiCallMeta) => void;
  onText: (text: string) => void;
  onDone: (done: AiCallDone) => void;
  /** An error event: the call failed after it started. `body` is the error envelope. */
  onError: (body: unknown) => void;
}

/** Runs a call and hands its events to `handlers`; refusals before the start throw ApiError. */
export async function streamAiCall(
  orgId: string,
  call: AiCallRequest,
  language: string,
  handlers: AiCallHandlers,
  signal: AbortSignal,
): Promise<void> {
  const { path, body } = callRoute(orgId, call, language);
  await requestStream(
    path,
    body,
    (event: StreamEvent) => {
      const data = isRecord(event.data) ? event.data : {};
      switch (event.event) {
        case "meta":
          handlers.onMeta(data as AiCallMeta);
          break;
        case "text":
          if (typeof data.text === "string") {
            handlers.onText(data.text);
          }
          break;
        case "done":
          handlers.onDone(data as AiCallDone);
          break;
        case "error":
          handlers.onError(data);
          break;
      }
    },
    { signal },
  );
}

/**
 * Why a new call would be refused now by a used-up limit, from the status: the daily calls or
 * tokens of the person, or the organization's tokens this month. Buttons stay visible but are
 * disabled with this reason.
 */
export function aiLimitReason(status: AiStatus | undefined): Reason | undefined {
  const usage = status?.usage;
  if (usage === undefined) {
    return undefined;
  }
  const over = (used: number, limit: number) => limit > 0 && used >= limit;
  if (over(usage.requests, usage.requestsLimit)) {
    return { reason: "ai.limit_user_requests", params: { max: String(usage.requestsLimit) } };
  }
  if (over(usage.tokens, usage.tokensLimit)) {
    return { reason: "ai.limit_user_tokens", params: { max: String(usage.tokensLimit) } };
  }
  if (over(usage.orgTokensMonth, usage.orgTokensMonthLimit)) {
    return { reason: "ai.limit_org_tokens", params: { max: String(usage.orgTokensMonthLimit) } };
  }
  return undefined;
}
