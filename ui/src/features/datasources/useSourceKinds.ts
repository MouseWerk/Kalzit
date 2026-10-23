import { useQuery } from "@tanstack/react-query";
import { datasourcesQuery } from "./api";

/**
 * The kind of each data source the caller can see, by id, for deciding whether a stored query
 * has anything to run. A source missing here (not visible, or the list still loading) has no
 * kind; `hasQuery` then reads the query's own fields.
 */
export function useSourceKinds(orgId: string | undefined): (id: string) => string | undefined {
  const sources = useQuery({ ...datasourcesQuery(orgId ?? ""), enabled: orgId !== undefined });
  const kinds = new Map((sources.data ?? []).map((source) => [source.id, source.kind]));
  return (id) => kinds.get(id);
}
