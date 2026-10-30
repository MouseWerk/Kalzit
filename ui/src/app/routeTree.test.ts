import { QueryClient } from "@tanstack/react-query";
import { type AnyRoute, createMemoryHistory, rootRouteId } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import {
  anmeldenRoute,
  appRoute,
  helpRoute,
  localLoginRoute,
  loginRoute,
  setupRoute,
  ssoTestRoute,
} from "./baseRoutes";
import { createAppRouter } from "./router";

function ancestors(route: AnyRoute): string[] {
  const ids: string[] = [];
  let parent: AnyRoute | undefined = route.parentRoute;
  while (parent !== undefined) {
    ids.push(parent.id);
    parent = parent.parentRoute;
  }
  return ids;
}

describe("route tree", () => {
  const router = createAppRouter(new QueryClient(), createMemoryHistory({ initialEntries: ["/"] }));
  const routes = Object.values(router.routesById as Record<string, AnyRoute>);

  // The sign-in pages: `/login`, the German address the server sends people back to after a
  // sign-in through a provider, the fixed local sign-in and the end of a test sign-in.
  const signInRoutes = [loginRoute, anmeldenRoute, localLoginRoute, ssoTestRoute];

  it("puts every page except setup, sign-in and help under the sign-in guard", () => {
    // Route ids exist only once the router has built the tree, so this is read here.
    const publicRoutes = new Set([
      setupRoute.id,
      helpRoute.id,
      ...signInRoutes.map((route) => route.id),
    ]);
    const unguarded = routes
      .filter((route) => route.id !== rootRouteId && route.id !== appRoute.id)
      .filter((route) => !publicRoutes.has(route.id))
      .filter((route) => !ancestors(route).includes(appRoute.id))
      .map((route) => route.id);
    expect(unguarded).toEqual([]);
  });

  it("finds the area routes, so the walk above is not vacuous", () => {
    const guarded = routes.filter((route) => ancestors(route).includes(appRoute.id));
    expect(guarded.map((route) => route.fullPath)).toEqual(
      expect.arrayContaining(["/", "/dashboards", "/explore", "/data-sources", "/admin"]),
    );
  });

  it("keeps setup, sign-in and help directly under the root", () => {
    for (const route of [setupRoute, helpRoute, ...signInRoutes]) {
      expect(route.parentRoute?.id).toBe(rootRouteId);
    }
  });
});
