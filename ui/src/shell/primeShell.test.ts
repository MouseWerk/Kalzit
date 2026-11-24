import { describe, expect, it } from "vitest";
import { createApp } from "../app/app";
import { statusQuery } from "../features/alerting/api";
import { FAKE_STATUS_ON } from "../features/alerting/test/fakeAlerting";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { forgetPrimed } from "./primedOrgs";
import { primeShell } from "./primeShell";

const STATUS = "/api/orgs/o1/alerting/status";

function setUp() {
  const server = installFakeServer({ signedIn: true });
  server.areas.alerting.status = { ...FAKE_STATUS_ON };
  // The app's own query client, with its retries, as a page load has it.
  const { queryClient } = createApp();
  const asked = () => server.calls.filter((call) => call.path === STATUS).length;
  return { server, queryClient, asked };
}

describe("loading the sidebar's data before the first frame", () => {
  it("asks a failing request once, without the app's retries", async () => {
    const { server, queryClient, asked } = setUp();
    server.failNext(STATUS, 500, "internal");
    const started = performance.now();
    await primeShell(queryClient, TEST_USER, 2_000);
    expect(performance.now() - started).toBeLessThan(900);
    expect(asked()).toBe(1);
    expect(queryClient.getQueryState(statusQuery("o1").queryKey)?.status).toBe("error");
  });

  it("does not wait again on a later page change while the request keeps failing", async () => {
    const { server, queryClient, asked } = setUp();
    server.failNext(STATUS, 500, "internal");
    await primeShell(queryClient, TEST_USER, 2_000);
    server.failNext(STATUS, 500, "internal");
    const started = performance.now();
    await primeShell(queryClient, TEST_USER, 2_000);
    expect(performance.now() - started).toBeLessThan(50);
    expect(asked()).toBe(1);
  });

  it("skips a request that already failed, also on a new first load", async () => {
    const { server, queryClient, asked } = setUp();
    server.failNext(STATUS, 500, "internal");
    await primeShell(queryClient, TEST_USER, 2_000);
    forgetPrimed();
    await primeShell(queryClient, TEST_USER, 2_000);
    expect(asked()).toBe(1);
    // The rest of the sidebar's data is there all the same.
    expect(queryClient.getQueryData(["org", "o1"])).toBeDefined();
  });
});
