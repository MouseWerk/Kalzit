/**
 * A query another page hands to Explore to open in its editor, without running it: a graph
 * panel's exploration turned into a Cypher query. Kept in memory for the one navigation to
 * Explore, never in the address (it can name many node ids) or in storage.
 */
export interface ExploreHandoff {
  datasourceId: string;
  query: unknown;
}

/** A query not picked up this soon (the navigation failed or went elsewhere) is dropped. */
export const HANDOFF_TTL_MS = 10_000;

let pending: { handoff: ExploreHandoff; at: number } | null = null;

export function handOffToExplore(handoff: ExploreHandoff): void {
  pending = { handoff, at: Date.now() };
}

/** The query handed over, if any, without taking it (Explore reads it while it first renders). */
export function peekExploreHandoff(): ExploreHandoff | null {
  if (pending !== null && Date.now() - pending.at > HANDOFF_TTL_MS) pending = null;
  return pending?.handoff ?? null;
}

/** Takes the query handed over, so a later visit to Explore starts as usual. */
export function clearExploreHandoff(): void {
  pending = null;
}
