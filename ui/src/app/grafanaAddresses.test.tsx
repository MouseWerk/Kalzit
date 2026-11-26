import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

/** Opens `path` signed in and answers where the app ends up. */
async function landsOn(path: string, uids: Record<string, string> = {}) {
  const server = installFakeServer({ signedIn: true });
  server.areas.provisioning.uids = uids;
  const { location } = renderApp(path);
  let where = "";
  await waitFor(() => {
    where = location().pathname;
    expect(where).not.toBe(path);
  });
  return { where, server };
}

describe("Grafana's addresses", () => {
  it("lead to the data sources", async () => {
    expect((await landsOn("/datasources")).where).toBe("/data-sources");
    expect((await landsOn("/connections/datasources")).where).toBe("/data-sources");
    expect((await landsOn("/connections/datasources/new")).where).toBe("/data-sources/new");
  });

  it("open a dashboard by its Grafana uid, with or without the slug", async () => {
    const known = { "lager-im-blick": "d-imported" };
    expect((await landsOn("/d/lager-im-blick", known)).where).toBe("/dashboards/d-imported");
    const { where, server } = await landsOn("/d/lager-im-blick/lager-im-blick", known);
    expect(where).toBe("/dashboards/d-imported");
    expect(
      server.calls.some((call) => call.path === "/api/orgs/o1/dashboards/by-uid/lager-im-blick"),
    ).toBe(true);
  });

  it("go to the dashboards list for a uid nobody knows", async () => {
    expect((await landsOn("/d/unbekannt")).where).toBe("/dashboards");
    expect((await landsOn("/d/unbekannt/some-slug")).where).toBe("/dashboards");
  });

  it("keep Explore where it is", async () => {
    installFakeServer({ signedIn: true });
    const { location } = renderApp("/explore");
    await waitFor(() => expect(location().pathname).toBe("/explore"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(location().pathname).toBe("/explore");
  });
});
