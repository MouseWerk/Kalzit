import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/i18n";
import { openAdmin, sent } from "../admin/test/openAdmin";
import { errorRate, hitRate } from "./api";
import { sampleReport } from "./test/fakeUsage";
import { trendFrame } from "./UsagePage";

const table = (name: string) => {
  const heading = screen.getByRole("heading", { name });
  const card = heading.closest("section");
  if (card === null) throw new Error(`no card for ${name}`);
  return within(card);
};

describe("usage insights", () => {
  it("shows an organization's usage with links and the privacy note", async () => {
    const { server } = await openAdmin("/admin/usage", { permissions: ["audit:read"] });
    expect(await screen.findByRole("heading", { level: 1, name: "Usage" })).toBeTruthy();
    expect(
      screen.getByText(/Counted per dashboard, panel and data source only, never per person/),
    ).toBeTruthy();
    expect(await screen.findByText("1,234")).toBeTruthy();
    // 25 of 1,000 queries failed; 300 of 400 cache lookups were hits.
    const tiles = screen.getByRole("list", { name: "Totals of the period" });
    expect(within(tiles).getByText("2.5%")).toBeTruthy();
    expect(within(tiles).getByText("75%")).toBeTruthy();

    const dashboards = table("Most viewed dashboards");
    const own = dashboards.getByRole("link", { name: "Sales by region" });
    expect(own.getAttribute("href")).toBe("/dashboards/d1");
    // Another organization's dashboard is named, not linked.
    expect(dashboards.getByText("Engine status").closest("a")).toBeNull();

    const slow = table("Slowest panels");
    expect(slow.getByRole("link", { name: "Orders per hour" }).getAttribute("href")).toBe(
      "/dashboards/d1?viewPanel=p7",
    );
    expect(slow.getByText("420 ms")).toBeTruthy();
    expect(slow.getByText("2.5 s")).toBeTruthy();

    const failing = table("Panels with errors");
    expect(failing.getByRole("link", { name: "Untitled panel" })).toBeTruthy();
    expect(failing.getByText("25%")).toBeTruthy();

    const sources = table("Data sources");
    expect(sources.getByRole("link", { name: "Warehouse" }).getAttribute("href")).toBe(
      "/data-sources/s1",
    );
    expect(sources.getByText("Timeouts: 20, Source errors: 5")).toBeTruthy();
    expect(sources.getByText("75%")).toBeTruthy();

    const unused = table("Unused dashboards");
    expect(unused.getByRole("link", { name: "Old inventory" })).toBeTruthy();
    expect(unused.getByText("Never since recording began")).toBeTruthy();
    expect(sent(server, "GET").some((path) => path.startsWith("/api/orgs/o1/usage?from="))).toBe(
      true,
    );
    expect(sent(server, "GET")).toContain("/api/orgs/o1/usage/unused?days=30");
  });

  it("asks for another period and another unused window", async () => {
    const { server, user } = await openAdmin("/admin/usage", { permissions: ["audit:read"] });
    await screen.findByText("1,234");
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Period" })).getByRole("radio", {
        name: "30 days",
      }),
    );
    await waitFor(() => {
      const last = sent(server, "GET")
        .filter((path) => path.startsWith("/api/orgs/o1/usage?"))
        .at(-1);
      const params = new URLSearchParams(last?.split("?")[1]);
      expect(Number(params.get("to")) - Number(params.get("from"))).toBe(30 * 24 * 3_600_000);
    });
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Not opened for" })).getByRole("radio", {
        name: "90 days",
      }),
    );
    await waitFor(() => expect(sent(server, "GET")).toContain("/api/orgs/o1/usage/unused?days=90"));
  });

  it("says when recording is off and links server admins to its setting", async () => {
    await openAdmin("/admin/usage", {
      permissions: [],
      isServerAdmin: true,
      setupServer: (server) => {
        server.areas.usage.report = { ...sampleReport(), recording: false };
      },
    });
    expect(
      await screen.findByText("Recording is off; new views and queries are not counted."),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to storage and retention" }).getAttribute("href"),
    ).toBe("/settings/storage");
  });

  it("says when recording is off without a link organization admins cannot follow", async () => {
    await openAdmin("/admin/usage", {
      permissions: ["audit:read"],
      setupServer: (server) => {
        server.areas.usage.report = { ...sampleReport(), recording: false };
      },
    });
    expect(
      await screen.findByText("Recording is off; new views and queries are not counted."),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Go to storage and retention" })).toBeNull();
  });

  it("shows no access without audit:read", async () => {
    const { server } = await openAdmin("/admin/usage", { permissions: ["users:write"] });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
    expect(sent(server, "GET").some((path) => path.includes("/usage"))).toBe(false);
  });

  it("lets server administrators choose an organization or all", async () => {
    const { server, user } = await openAdmin("/admin/usage", {
      permissions: [],
      isServerAdmin: true,
    });
    await screen.findByText("1,234");
    // The current organization first.
    expect(sent(server, "GET").some((path) => path.startsWith("/api/admin/usage?from="))).toBe(
      true,
    );
    expect(sent(server, "GET").at(-1)).toMatch(/orgId=o1/);
    const page = within(screen.getByRole("region", { name: "Usage" }));
    await user.selectOptions(await page.findByLabelText("Organization"), "");
    await waitFor(() => {
      const last = sent(server, "GET")
        .filter((path) => path.startsWith("/api/admin/usage?"))
        .at(-1);
      expect(last).not.toMatch(/orgId=/);
    });
    // Every organization: rows name theirs.
    expect(await table("Most viewed dashboards").findByText("Difference Engines")).toBeTruthy();
  });
});

describe("dropped events", () => {
  it("names them when the server view reports them, and leaves them out otherwise", async () => {
    await openAdmin("/admin/usage", {
      permissions: [],
      isServerAdmin: true,
      setupServer: (server) => {
        server.areas.usage.report = { ...sampleReport(), dropped: 12 };
      },
    });
    expect(await screen.findByText(/^12 events were not counted/)).toBeTruthy();
  });

  it("shows nothing about them in an organization view without the count", async () => {
    await openAdmin("/admin/usage", {
      permissions: ["audit:read"],
      setupServer: (server) => {
        const { dropped: _, ...report } = sampleReport();
        server.areas.usage.report = report;
      },
    });
    await screen.findByText("1,234");
    expect(screen.queryByText(/events were not counted/)).toBeNull();
  });
});

describe("usage helpers", () => {
  it("computes shares without dividing by zero", () => {
    expect(hitRate(0, 0)).toBeNull();
    expect(hitRate(3, 1)).toBe(0.75);
    expect(errorRate(0, 0)).toBeNull();
    expect(errorRate(1, 4)).toBe(0.25);
  });

  it("turns the trend into a frame for the time series panel", () => {
    const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
    const frame = trendFrame(sampleReport(), t);
    expect(frame.fields.map((field) => field.name)).toEqual([
      "Time",
      "Dashboard views",
      "Panel runs",
      "Data source queries",
      "Errors",
    ]);
    expect(frame.fields[0]?.type).toBe("time");
    expect(frame.fields[4]?.values).toEqual([3, 0]);
  });
});
