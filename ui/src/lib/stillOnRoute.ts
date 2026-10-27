import type { AnyRouter } from "@tanstack/react-router";

/**
 * Whether the router's latest location, also one whose page is still loading, is the page of
 * `routeId`. The router matches the path itself, so a trailing slash or a base path makes no
 * difference. A list's delayed search checks it before it writes the search into the address:
 * a result opened within the pause has left the list even while the list still shows.
 */
export function stillOnRoute(router: AnyRouter, routeId: string): boolean {
  const location = router.latestLocation;
  const matches = router.matchRoutes(location.pathname, location.search);
  return matches.at(-1)?.routeId === routeId;
}
