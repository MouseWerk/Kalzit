import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FAKE_STATUS_ON } from "../features/alerting/test/fakeAlerting";
import { FAKE_REPORTS_ON } from "../features/reports/test/fakeReports";
import { installFakeServer } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

// A short wait for the navigation's data, so the slow case below does not wait the real limit.
vi.mock("./primeShell", async (original) => {
  const actual = await original<typeof import("./primeShell")>();
  return {
    ...actual,
    primeShell: (...args: Parameters<typeof actual.primeShell>) =>
      actual.primeShell(args[0], args[1], 50),
  };
});

/**
 * The rows of the navigation in order: an entry by its link's name, a placeholder by the page it
 * holds, and the pinned area's heading.
 */
function navRows(nav: HTMLElement): string[] {
  return [
    ...nav.querySelectorAll<HTMLElement>(
      ".shell__nav-list > li, .shell__pins > .shell__group-heading",
    ),
  ].map((row) => {
    const held = row.dataset.navPlaceholder;
    if (held !== undefined) return `placeholder ${held}`;
    const link = row.querySelector("a");
    return link === null ? (row.textContent ?? "") : `link ${link.getAttribute("href")}`;
  });
}

function openWithAreasOn(path: string) {
  const server = installFakeServer({ signedIn: true });
  server.areas.alerting.status = { ...FAKE_STATUS_ON };
  server.areas.reports.status = FAKE_REPORTS_ON;
  return { server, ...renderApp(path) };
}

describe("the navigation's first frame", () => {
  it("draws the final entries from the first frame on a full page load", async () => {
    const { app } = openWithAreasOn("/data-sources");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const first = navRows(nav);
    expect(first).toContain("link /alerting");
    expect(first).toContain("link /reports");
    expect(first).toContain("Pinned");
    expect(first.some((row) => row.startsWith("placeholder"))).toBe(false);
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
    expect(navRows(nav)).toEqual(first);
  });

  it("holds the row of an entry whose data comes late, so nothing below it moves", async () => {
    const server = installFakeServer({ signedIn: true });
    server.areas.alerting.status = { ...FAKE_STATUS_ON };
    server.areas.reports.status = FAKE_REPORTS_ON;
    const release = server.holdNext("/api/orgs/o1/alerting/status");
    const { app } = renderApp("/data-sources");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const first = navRows(nav);
    const at = first.indexOf("placeholder /alerting");
    expect(at).toBeGreaterThan(-1);
    release();
    await waitFor(() => expect(navRows(nav)[at]).toBe("link /alerting"));
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
    const loaded = navRows(nav);
    expect(loaded).toHaveLength(first.length);
    expect(loaded.toSpliced(at, 1)).toEqual(first.toSpliced(at, 1));
  });
});
