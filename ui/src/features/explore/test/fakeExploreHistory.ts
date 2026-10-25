import {
  error,
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";
import type { HistoryEntry } from "../history";

/**
 * Fake routes of docs/api/explore-history.md: the caller's own entries, newest first, filtered by
 * data source and by text in the query, paged by a cursor (a position in the list), deleted one
 * by one or all at once. Runs from Explore are added by the data source fake.
 */

export interface FakeExploreHistoryState {
  /** Newest first. */
  entries: HistoryEntry[];
  /** Every `limit` the list was asked with, in order. */
  limits: number[];
}

export function exploreHistoryFake(_areas: FakeAreaStates): FakeArea<FakeExploreHistoryState> {
  const state: FakeExploreHistoryState = { entries: [], limits: [] };
  return {
    state,
    handle({ method, route, search }: FakeRequest) {
      const parts = route.split("/").slice(4);
      if (parts[0] !== "explore" || parts[1] !== "history") {
        return undefined;
      }
      if (parts.length === 2 && method === "GET") {
        const limit = Number(search.get("limit") ?? 50);
        const start = Number(search.get("cursor") ?? 0);
        const source = search.get("datasourceId");
        const text = search.get("q")?.toLowerCase();
        state.limits.push(limit);
        const all = state.entries
          .filter((e) => source === null || e.datasourceId === source)
          .filter(
            (e) => text === undefined || JSON.stringify(e.query).toLowerCase().includes(text),
          );
        const items = all.slice(start, start + limit);
        const next = start + limit < all.length ? String(start + limit) : null;
        return json(200, { items, nextCursor: next });
      }
      if (parts.length === 2 && method === "DELETE") {
        state.entries = [];
        return new Response(null, { status: 204 });
      }
      if (parts.length === 3 && method === "DELETE") {
        const before = state.entries.length;
        state.entries = state.entries.filter((e) => e.id !== parts[2]);
        return state.entries.length === before
          ? error(404, "not_found")
          : new Response(null, { status: 204 });
      }
      return undefined;
    },
  };
}
