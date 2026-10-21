import { describe, expect, it } from "vitest";
import { PRELOADED_PAGES } from "../../test/renderApp";

describe("lazy pages in tests", () => {
  it("are all loaded by the app render helper before a test navigates to them", () => {
    // A cold module transform during a test's first navigation made findBy time out on CI.
    expect(PRELOADED_PAGES).toEqual(
      expect.arrayContaining([
        "/_app/dashboards",
        "/_app/dashboards/$dashboardId",
        "/_app/dashboards/trash",
        "/_app/dashboards/$dashboardId/versions",
        "/_app/explore",
        "/_app/data-sources",
        "/_app/data-sources/new",
        "/_app/data-sources/$datasourceId",
      ]),
    );
  });
});
