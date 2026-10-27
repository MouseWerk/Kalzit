import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { createAppRouter } from "../app/router";
import { stillOnRoute } from "./stillOnRoute";

function routerAt(path: string) {
  return createAppRouter(new QueryClient(), createMemoryHistory({ initialEntries: [path] }));
}

describe("stillOnRoute", () => {
  it("is true on the list, with or without a trailing slash or a search", () => {
    expect(stillOnRoute(routerAt("/explore/saved"), "/_app/explore/saved")).toBe(true);
    expect(stillOnRoute(routerAt("/explore/saved/"), "/_app/explore/saved")).toBe(true);
    expect(stillOnRoute(routerAt("/explore/saved?q=Umsatz"), "/_app/explore/saved")).toBe(true);
    expect(stillOnRoute(routerAt("/dashboards/"), "/_app/dashboards")).toBe(true);
  });

  it("is false once the latest location is a page below the list or elsewhere", () => {
    expect(stillOnRoute(routerAt("/explore/saved/a1"), "/_app/explore/saved")).toBe(false);
    expect(stillOnRoute(routerAt("/explore/saved/trash"), "/_app/explore/saved")).toBe(false);
    expect(stillOnRoute(routerAt("/dashboards/d1"), "/_app/dashboards")).toBe(false);
    expect(stillOnRoute(routerAt("/explore"), "/_app/explore/saved")).toBe(false);
  });

  it("follows a navigation that has started but not finished loading", async () => {
    const router = routerAt("/explore/saved");
    await router.load();
    expect(stillOnRoute(router, "/_app/explore/saved")).toBe(true);
    // Not awaited: the address has moved, the page of the new location is still loading.
    const loading = router.navigate({
      to: "/explore/saved/$analysisId",
      params: { analysisId: "a1" },
    });
    expect(router.state.resolvedLocation?.pathname).toBe("/explore/saved");
    expect(stillOnRoute(router, "/_app/explore/saved")).toBe(false);
    await loading.catch(() => undefined);
  });
});
