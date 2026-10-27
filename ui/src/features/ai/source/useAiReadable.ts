import { useQuery } from "@tanstack/react-query";
import { aiAdminKeys, fetchAiReadableSources } from "../adminApi";
import { useAiStatusFor } from "../useAiStatus";

/**
 * The data sources open to AI in an organization, for the "AI may read" badge of the list.
 * Asked only while AI is usable there; otherwise empty, so nothing of AI shows.
 */
export function useAiReadableSources(orgId: string | undefined): ReadonlySet<string> {
  const { usable } = useAiStatusFor(orgId);
  const query = useQuery({
    queryKey: aiAdminKeys.readable(orgId ?? ""),
    queryFn: ({ signal }) => fetchAiReadableSources(orgId ?? "", signal),
    enabled: usable && orgId !== undefined,
  });
  return new Set(usable ? (query.data ?? []) : []);
}
