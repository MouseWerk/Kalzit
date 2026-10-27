import { queryOptions } from "@tanstack/react-query";
import { expectShape, isRecord, request } from "../../api/client";
import type { AiStatus } from "../../api/generated/shapes";

/** `GET /api/orgs/{orgId}/ai/status` (docs/api/ai.md): whether AI may be shown at all. */
export function isAiStatus(value: unknown): value is AiStatus {
  return (
    isRecord(value) &&
    typeof value.enabled === "boolean" &&
    typeof value.usable === "boolean" &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

export async function fetchAiStatus(orgId: string, signal?: AbortSignal): Promise<AiStatus> {
  const path = `/api/orgs/${encodeURIComponent(orgId)}/ai/status`;
  return expectShape(await request("GET", path, undefined, { signal }), isAiStatus, "AI status");
}

/**
 * `POST /api/orgs/{orgId}/ai/notice`: the user read the first-use notice for this provider (the
 * status's `provider.id`). The server refuses AI calls until then, once per person and provider.
 */
export async function acknowledgeAiNotice(orgId: string, providerId: string): Promise<void> {
  await request("POST", `/api/orgs/${encodeURIComponent(orgId)}/ai/notice`, { providerId });
}

export const AI_STATUS_QUERY_KEY = "aiStatus";

export function aiStatusQuery(orgId: string) {
  return queryOptions({
    queryKey: [AI_STATUS_QUERY_KEY, orgId],
    queryFn: ({ signal }) => fetchAiStatus(orgId, signal),
    staleTime: 60_000,
  });
}
