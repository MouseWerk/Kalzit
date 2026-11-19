import { screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { translate } from "../../i18n/i18n";
import { expectConsoleOutput } from "../../test/console";
import { installFakeServer } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { optionLabels } from "../../test/select";
import { openAdmin } from "../admin/test/openAdmin";
import { emptyModel, type PanelModel } from "../dashboards/model";
import { addDashboard } from "../dashboards/test/fakeDashboards";
import { errorMessage } from "../dashboards/ui/errors";
import { PG_ID } from "../datasources/test/fakeDatasources";
import type { Share } from "./api";
import { sharingErrorText } from "./limits";
import {
  afterText,
  bytesText,
  clampToWindow,
  DAY_MS,
  defaultExpiryDays,
  durationText,
  expiryAt,
  expiryChoices,
  fromDateInput,
  shownStatus,
  toDateInput,
  windowMargin,
} from "./model";
import { FAKE_TOKEN, fakeLink, fakePublicDashboard, fakeSnapshot } from "./test/fakeSharing";

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("en", key, params ?? {});
const de = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("de", key, params ?? {});

const orders: PanelModel = {
  id: "p1",
  type: "table",
  title: "Orders",
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM orders" } }],
  transformations: [],
  options: {},
  fieldConfig: {},
};

const ADMIN = [
  "dashboards:read",
  "dashboards:write",
  "dashboards:share",
  "dashboards:public",
  "datasources:query",
  "datasources:read",
  "folders:read",
  "settings:read",
  "org:write",
];
const EDITOR = ["dashboards:read", "dashboards:write", "dashboards:share", "datasources:query"];

function openDashboard(
  permissions: string[],
  arrange: (server: ReturnType<typeof installFakeServer>) => void = () => undefined,
  options: { isServerAdmin?: boolean } = {},
) {
  return openAdmin("/dashboards/d-main", {
    permissions,
    ...options,
    setupServer: (server) => {
      addDashboard(server.areas.dashboards, "d-main", {
        ...emptyModel("Main"),
        timeRange: { from: "now-24h", to: "now" },
        variables: [{ name: "region", type: "custom", options: ["Nord", "West"], current: "Nord" }],
        panels: [orders],
      });
      arrange(server);
    },
  });
}

async function openShare(user: Awaited<ReturnType<typeof openDashboard>>["user"]) {
  await user.click(await screen.findByRole("button", { name: "Share" }));
  return screen.findByRole("dialog", { name: "Share “Main”" });
}

// The dialog loads when it is first opened; loaded here, no test waits on a cold module.
beforeAll(async () => {
  await import("./ShareDialog");
});

describe("sharing model", () => {
  it("offers expiries within the server's longest, which is always a choice", () => {
    expect(expiryChoices(365)).toEqual([1, 7, 30, 90, 180, 365]);
    expect(expiryChoices(14)).toEqual([1, 7, 14]);
    expect(defaultExpiryDays(365)).toBe(30);
    expect(defaultExpiryDays(14)).toBe(14);
  });

  it("names lengths of time, in a plural unit where a sentence needs one", () => {
    expect(durationText(t, 7 * DAY_MS)).toBe("7 days");
    expect(durationText(t, DAY_MS)).toBe("1 day");
    expect(durationText(t, DAY_MS, true)).toBe("24 hours");
    expect(durationText(t, 3_600_000, true)).toBe("60 minutes");
    expect(durationText(t, 365 * DAY_MS)).toBe("1 year");
    // German declines the unit after "nach": Tagen, not Tage.
    expect(durationText(de, 7 * DAY_MS)).toBe("7 Tage");
    expect(afterText(de, 30)).toBe("nach 30 Tagen");
    expect(afterText(de, 365)).toBe("nach 1 Jahr");
  });

  it("shows an active share in its last week as expiring soon, and a passed one as expired", () => {
    const now = Date.UTC(2026, 10, 14);
    const share = (patch: Record<string, unknown>): Share =>
      ({ kind: "link", orgId: "o1", link: fakeLink(patch) }) as unknown as Share;
    expect(shownStatus(share({ expiresAt: now + 30 * DAY_MS }), now)).toBe("active");
    expect(shownStatus(share({ expiresAt: now + 6 * DAY_MS }), now)).toBe("expiresSoon");
    expect(shownStatus(share({ expiresAt: now - 1 }), now)).toBe("expired");
    expect(shownStatus(share({ status: "suspended", expiresAt: now + DAY_MS }), now)).toBe(
      "suspended",
    );
    expect(shownStatus(share({ status: "revoked" }), now)).toBe("revoked");
  });

  it("holds a visitor's range inside the link's window", () => {
    const now = Date.UTC(2026, 10, 14, 10, 42);
    const window = 7 * DAY_MS;
    const inside = { from: now - DAY_MS, to: now };
    expect(clampToWindow(inside, window, now)).toEqual({ range: inside, clamped: false });
    // Wider than the window: held inside it, two minutes in from its start, since the request
    // arrives a moment after the range was worked out.
    const wide = clampToWindow({ from: now - 30 * DAY_MS, to: now + DAY_MS }, window, now);
    expect(wide).toEqual({ range: { from: now - window + 120_000, to: now }, clamped: true });
    // Exactly the window (a start range as long as it) is not called limited.
    const whole = clampToWindow({ from: now - window, to: now }, window, now);
    expect(whole).toEqual({ range: { from: now - window + 120_000, to: now }, clamped: false });
    // A window of minutes keeps most of itself.
    expect(windowMargin(60_000)).toBe(15_000);
    const tiny = clampToWindow({ from: now - 3_600_000, to: now }, 60_000, now).range;
    expect(tiny.to - tiny.from).toBe(45_000);
  });

  it("keeps a share made at the longest expiry a minute inside it", () => {
    const now = Date.UTC(2026, 10, 14);
    expect(expiryAt(30, 365, now)).toBe(now + 30 * DAY_MS);
    expect(expiryAt(365, 365, now)).toBe(now + 365 * DAY_MS - 60_000);
    // No limit known: nothing to stay inside of.
    expect(expiryAt(365, undefined, now)).toBe(now + 365 * DAY_MS);
  });

  it("reads a date input as the end of that day and writes it back", () => {
    const end = fromDateInput("2026-12-14") ?? 0;
    expect(new Date(end).getHours()).toBe(23);
    expect(toDateInput(end)).toBe("2026-12-14");
    expect(fromDateInput("14.12.2026")).toBeUndefined();
  });

  it("names sizes in the unit people expect", () => {
    expect(bytesText(1_600_000, "en")).toBe("1.5 MB");
    expect(bytesText(412 * 1024, "de")).toBe("412 KB");
    expect(bytesText(10 * 1024 * 1024, "de")).toBe("10 MB");
  });

  it("translates the reasons of refusals, with sizes in megabytes", () => {
    const refusal = (reason: string, params: Record<string, string>) =>
      new ApiError("validation", 422, "server text", undefined, {
        error: { code: "validation", message: "server text", reason, params },
      });
    expect(
      sharingErrorText(
        t,
        refusal("sharing.snapshot_too_large", { max: String(10 * 1024 * 1024) }),
        "en",
      ),
    ).toContain("(10 MB)");
    expect(sharingErrorText(t, refusal("sharing.expiry_invalid", { maxDays: "90" }), "en")).toBe(
      t("sharing.reason.expiry_invalid", { maxDays: 90 }),
    );
    // A save that reaches live public links names them (owner decision D1).
    const links = new ApiError("forbidden", 403, "server text", "model", {
      error: {
        code: "forbidden",
        message: "server text",
        reason: "sharing.public_links_active",
        params: { links: "2" },
      },
    });
    expect(errorMessage(t, links)).toContain("Active public links on this dashboard: 2.");
    expect(errorMessage(t, links)).toContain("dashboards:public");
  });
});

describe("Share dialog", () => {
  it("builds the link in the organization with range and variables, or without", async () => {
    const { user } = await openDashboard(ADMIN);
    const dialog = await openShare(user);
    const address = within(dialog).getByLabelText("Address") as HTMLInputElement;
    expect(address.value).toContain("/dashboards/d-main?from=now-24h&to=now&var-region=Nord");
    await user.click(within(dialog).getByRole("switch", { name: "Include the variables" }));
    expect(address.value).not.toContain("var-region");
    await user.click(within(dialog).getByRole("switch", { name: "Include the time range" }));
    expect(address.value.endsWith("/dashboards/d-main")).toBe(true);
    await user.click(within(dialog).getByRole("switch", { name: "Only this panel" }));
    expect(address.value).toContain("viewPanel=p1");
    // The address needs a session: the note says so.
    expect(within(dialog).getByText(t("sharing.org.note"))).toBeTruthy();
  });

  it("creates a public link with expiry, window and the fixed values, and shows it once", async () => {
    const { user, server } = await openDashboard(ADMIN);
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Public link" }));
    expect(within(dialog).getByText(t("sharing.public.lead"))).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Create public link" }));
    const address = (await within(dialog).findByLabelText("Public link")) as HTMLInputElement;
    expect(address.value.endsWith(`/public/dashboards/${FAKE_TOKEN}`)).toBe(true);
    const sent = server.areas.sharing.requests.at(-1);
    expect(sent?.route).toBe("/api/orgs/o1/dashboards/d-main/public-links");
    expect(sent?.body).toMatchObject({
      maxWindowMs: 7 * DAY_MS,
      timeRange: { from: "now-24h", to: "now" },
      variables: { region: "Nord" },
    });
    const days = (Number(sent?.body.expiresAt) - Date.now()) / DAY_MS;
    expect(Math.round(days)).toBe(30);
    // The tab counts the link now.
    await waitFor(() =>
      expect(within(dialog).getByRole("tab", { name: "Public link 1" })).toBeTruthy(),
    );
  });

  it("asks before revoking, with the focus on Cancel, and revokes for good", async () => {
    const { user, server } = await openDashboard(ADMIN, (fake) => {
      fake.areas.sharing.links.push(fakeLink());
    });
    const dialog = await openShare(user);
    await user.click(await within(dialog).findByRole("tab", { name: "Public link 1" }));
    await user.click(await within(dialog).findByRole("button", { name: "Revoke" }));
    const ask = await screen.findByRole("alertdialog", { name: "Revoke “Main”?" });
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" }));
    expect(within(ask).getByText(/This link is not available/)).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(server.areas.sharing.links[0]?.status).toBe("revoked");
    expect(server.areas.sharing.requests.at(-1)?.route).toBe("/api/orgs/o1/public-links/l1/revoke");
  });

  it("locks the public tab for an editor and says which permission is missing", async () => {
    const { user } = await openDashboard(EDITOR);
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Public link" }));
    expect(await within(dialog).findByText(t("sharing.block.permission"))).toBeTruthy();
    const create = within(dialog).getByRole("button", { name: "Create public link" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    // Snapshots in the organization keep working; "Public" is locked there with the reason.
    await user.click(within(dialog).getByRole("tab", { name: "Snapshot" }));
    expect(
      (within(dialog).getByRole("radio", { name: "Public" }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "Create snapshot" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("says which switch is off, to every member", async () => {
    const { user } = await openDashboard(ADMIN, (fake) => {
      fake.areas.sharing.serverPublic = false;
    });
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Public link" }));
    expect(await within(dialog).findByText(t("sharing.block.server"))).toBeTruthy();
  });

  it("says that the organization turned it off", async () => {
    const { user } = await openDashboard(ADMIN, (fake) => {
      fake.areas.sharing.orgPublic = false;
    });
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Public link" }));
    expect(await within(dialog).findByText(t("sharing.block.org"))).toBeTruthy();
  });

  it("names the server's limits, not assumed ones", async () => {
    const { user } = await openDashboard(ADMIN, (fake) => {
      fake.areas.sharing.maxExpiryDays = 14;
    });
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Public link" }));
    // The choice follows the limits once they arrive: 14 days at most, so not the usual 30.
    const expires = await within(dialog).findByRole("combobox", { name: "Expires" });
    await waitFor(() => expect(expires.textContent).toContain("after 14 days"));
    expect(optionLabels(expires)).toEqual(["after 1 day", "after 7 days", "after 14 days"]);
    expect(within(dialog).getByText(/At most 14 days\./)).toBeTruthy();
  });

  it("states no limit a server without the limits route did not name, and learns from refusals", async () => {
    const { user, server } = await openDashboard(ADMIN, (fake) => {
      fake.areas.sharing.limitsRoute = false;
      fake.areas.sharing.maxExpiryDays = 14;
    });
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Public link" }));
    expect(within(dialog).queryByText(/At most/)).toBeNull();
    // 30 days is the default while nothing is known; the server refuses it and names 14.
    await user.click(within(dialog).getByRole("button", { name: "Create public link" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    const expires = within(dialog).getByRole("combobox", { name: "Expires" });
    await waitFor(() => expect(expires.textContent).toContain("after 14 days"));
    expect(within(dialog).getByText(/At most 14 days\./)).toBeTruthy();
    // The next attempt is within the limit, a minute inside it.
    await user.click(within(dialog).getByRole("button", { name: "Create public link" }));
    await within(dialog).findByLabelText("Public link");
    const days =
      (Number(server.areas.sharing.requests.at(-1)?.body.expiresAt) - Date.now()) / DAY_MS;
    expect(days).toBeLessThan(14);
    expect(days).toBeGreaterThan(13.99);
    expectConsoleOutput();
  });

  it("learns of a switch that is off from the server's refusal", async () => {
    const { user } = await openDashboard(ADMIN, (fake) => {
      fake.areas.sharing.limitsRoute = false;
      fake.areas.sharing.serverPublic = false;
    });
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Public link" }));
    await user.click(within(dialog).getByRole("button", { name: "Create public link" }));
    expect(await within(dialog).findByText(t("sharing.block.off"))).toBeTruthy();
    expectConsoleOutput();
  });

  it("shows the form again after the link just made is revoked", async () => {
    const { user } = await openDashboard(ADMIN);
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Public link" }));
    await user.click(within(dialog).getByRole("button", { name: "Create public link" }));
    await within(dialog).findByLabelText("Public link");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    const ask = await screen.findByRole("alertdialog");
    await user.click(within(ask).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // Not "created" any more: no address of a link that no longer works, the form is back.
    await waitFor(() =>
      expect(within(dialog).queryByRole("textbox", { name: "Public link" })).toBeNull(),
    );
    expect(within(dialog).queryByText(/Public link created/)).toBeNull();
    // The focus is on the form's main button, not on the page behind the dialog.
    const create = within(dialog).getByRole("button", { name: "Create public link" });
    await waitFor(() => expect(document.activeElement).toBe(create));
  });

  it("makes a snapshot in the organization and offers to open it", async () => {
    const { user, server } = await openDashboard(ADMIN);
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Snapshot" }));
    // Every panel has its answer: no warning about frozen empty panels.
    expect(within(dialog).queryByText(/no result right now/)).toBeNull();
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Main, frozen");
    await user.click(within(dialog).getByRole("button", { name: "Create snapshot" }));
    const open = await within(dialog).findByRole("link", { name: "Open" });
    expect(open.getAttribute("href")).toBe("/dashboards/d-main/snapshots/s1");
    const sent = server.areas.sharing.requests.at(-1);
    expect(sent?.body).toMatchObject({
      title: "Main, frozen",
      public: false,
      variables: { region: "Nord" },
    });
    const range = sent?.body.timeRange as { from: number; to: number };
    expect(range.to - range.from).toBe(DAY_MS);
  });

  it("warns before a snapshot freezes a panel that has no result now", async () => {
    const { user } = await openDashboard(ADMIN, (server) => {
      server.areas.datasources.respond = () => ({
        error: { code: "query_rejected", message: "region has no value" },
      });
    });
    // The panel on screen shows its failed answer first.
    const panel = await screen.findByRole("article", { name: "Orders" });
    expect(await within(panel).findByRole("alert")).toBeTruthy();
    const dialog = await openShare(user);
    await user.click(within(dialog).getByRole("tab", { name: "Snapshot" }));
    expect(
      within(dialog).getByText(t("sharing.snapshot.noResultOne", { names: "Orders", count: 1 })),
    ).toBeTruthy();
    // A warning, not a block: the snapshot can still be made.
    expect(
      (within(dialog).getByRole("button", { name: "Create snapshot" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("keeps Save in the expiry dialog and reports the limit at the field", async () => {
    const { user, server } = await openDashboard(ADMIN, (fake) => {
      fake.areas.sharing.links.push(fakeLink());
    });
    const dialog = await openShare(user);
    await user.click(await within(dialog).findByRole("tab", { name: "Public link 1" }));
    await user.click(await within(dialog).findByRole("button", { name: "Change expiry" }));
    const expiry = await screen.findByRole("dialog", { name: "Change expiry" });
    const field = within(expiry).getByLabelText("Expires on");
    const late = toDateInput(Date.now() + 500 * DAY_MS);
    await user.clear(field);
    await user.type(field, late);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(within(expiry).getByRole("alert").textContent).toMatch(/at the latest/);
    const save = within(expiry).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    const before = server.areas.sharing.requests.length;
    await user.click(save);
    expect(server.areas.sharing.requests.length).toBe(before);
    // A day within the limit is saved.
    const fine = toDateInput(Date.now() + 60 * DAY_MS);
    await user.clear(field);
    await user.type(field, fine);
    await user.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change expiry" })).toBeNull());
    expect(toDateInput(Number(server.areas.sharing.links[0]?.expiresAt))).toBe(fine);
  });

  it("accepts the last day the expiry dialog names", async () => {
    const { user, server } = await openDashboard(ADMIN, (fake) => {
      fake.areas.sharing.links.push(fakeLink());
    });
    const dialog = await openShare(user);
    await user.click(await within(dialog).findByRole("tab", { name: "Public link 1" }));
    await user.click(await within(dialog).findByRole("button", { name: "Change expiry" }));
    const expiry = await screen.findByRole("dialog", { name: "Change expiry" });
    const field = within(expiry).getByLabelText("Expires on") as HTMLInputElement;
    // The day the hint and the field's own limit name: one year from today.
    await waitFor(() => expect(field.max).not.toBe(""));
    const last = field.max;
    await user.clear(field);
    await user.type(field, last);
    expect(field.getAttribute("aria-invalid")).toBeNull();
    const started = Date.now();
    await user.click(within(expiry).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change expiry" })).toBeNull());
    // Saved as the limit itself, not the end of that day, which would lie past it.
    const saved = Number(server.areas.sharing.links[0]?.expiresAt);
    expect(saved).toBeLessThanOrEqual(started + 365 * DAY_MS);
    expect(toDateInput(saved)).toBe(last);
  });
});

/** The range a visitor's panel query asked for. */
function rangeOf(call: { body: unknown } | undefined) {
  return (call?.body as { timeRange?: { from: number; to: number } } | undefined)?.timeRange;
}

describe("pages for visitors", () => {
  function publicLink(server: ReturnType<typeof installFakeServer>) {
    server.areas.sharing.publicLinks[FAKE_TOKEN] = {
      dashboard: fakePublicDashboard(),
      timeRange: { from: "now-24h", to: "now" },
      maxWindowMs: 7 * DAY_MS,
      expiresAt: Date.now() + 30 * DAY_MS,
    };
  }

  it("shows a public link without a session or navigation, values fixed", async () => {
    const server = installFakeServer();
    publicLink(server);
    renderApp(`/public/dashboards/${FAKE_TOKEN}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Main" })).toBeTruthy();
    const panel = await screen.findByRole("article", { name: "Orders" });
    expect(await within(panel).findByText("Krause")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    // Fixed values read as text, not only by the lock.
    const fixed = screen.getByRole("list", { name: "Fixed values" });
    expect(fixed.textContent).toContain("Region");
    expect(fixed.textContent).toContain("Nord");
    expect(within(fixed).getByText("fixed")).toBeTruthy();
    // The panel's query carries a range and nothing else.
    const query = server.calls.find((call) => call.path.includes("/panels/p1/query"));
    expect(Object.keys(query?.body as object)).toEqual(["timeRange"]);
    const range = rangeOf(query);
    expect((range?.to ?? 0) - (range?.from ?? 0)).toBe(DAY_MS);
  });

  it("offers ranges inside the window only; the others are disabled with the reason", async () => {
    const server = installFakeServer();
    publicLink(server);
    const { user } = renderApp(`/public/dashboards/${FAKE_TOKEN}`);
    await user.click(await screen.findByRole("button", { name: "Last 24 hours" }));
    const menu = screen.getByRole("dialog", { name: "Time range" });
    const outside = within(menu).getByRole("button", { name: /Last 30 days/ });
    expect(outside.getAttribute("aria-disabled")).toBe("true");
    expect(outside.textContent).toContain("outside the window");
    expect(within(menu).getByText(/The last 7 days are shared/)).toBeTruthy();
    const before = server.calls.length;
    await user.click(outside);
    expect(server.calls.length).toBe(before);
    await user.click(within(menu).getByRole("button", { name: /Last 6 hours/ }));
    expect(await screen.findByRole("button", { name: "Last 6 hours" })).toBeTruthy();
    await waitFor(() => {
      const last = server.calls.filter((call) => call.path.includes("/panels/p1/query")).at(-1);
      const range = rangeOf(last);
      expect((range?.to ?? 0) - (range?.from ?? 0)).toBe(6 * 3_600_000);
    });
  });

  it("counts the window from the server's clock, whatever the browser's says", async () => {
    // A link whose start range is as long as its window, opened in a browser whose clock is
    // five minutes ahead: both used to reach outside the window as the server counts it.
    const server = installFakeServer();
    server.areas.sharing.clockOffsetMs = -300_000;
    server.areas.sharing.publicLinks[FAKE_TOKEN] = {
      dashboard: fakePublicDashboard(),
      timeRange: { from: "now-1h", to: "now" },
      maxWindowMs: 3_600_000,
      expiresAt: Date.now() + 30 * DAY_MS,
    };
    renderApp(`/public/dashboards/${FAKE_TOKEN}`);
    const panel = await screen.findByRole("article", { name: "Orders" });
    expect(await within(panel).findByText("Krause")).toBeTruthy();
    const queries = server.calls.filter((call) => call.path.includes("/panels/p1/query"));
    expect(queries).toHaveLength(1);
    const range = rangeOf(queries[0]);
    // Two minutes inside the window's start, and ending at the server's now.
    expect((range?.to ?? 0) - (range?.from ?? 0)).toBe(3_600_000 - 120_000);
    expect(Math.abs((range?.to ?? 0) - (Date.now() - 300_000))).toBeLessThan(5_000);
  });

  it("asks the server for its clock again when a range was refused, and sends the same range", async () => {
    const server = installFakeServer();
    publicLink(server);
    server.areas.sharing.refuseWindow = 1;
    renderApp(`/public/dashboards/${FAKE_TOKEN}`);
    const panel = await screen.findByRole("article", { name: "Orders" });
    expect(await within(panel).findByText("Krause")).toBeTruthy();
    const queries = server.calls.filter((call) => call.path.includes("/panels/p1/query"));
    expect(queries).toHaveLength(2);
    // The clock was read a moment ago with the page, so that reading is used again (panels
    // share one within ten seconds); an older one is fetched anew, see the next test. The range
    // is the one asked for, not a shorter one.
    const views = server.calls.filter(
      (call) => call.path === `/api/public/dashboards/${FAKE_TOKEN}`,
    );
    expect(views).toHaveLength(1);
    const range = rangeOf(queries[1]);
    expect((range?.to ?? 0) - (range?.from ?? 0)).toBe(DAY_MS);
    expect(screen.getByRole("button", { name: "Last 24 hours" })).toBeTruthy();
    expect(screen.queryByText(t("sharing.viewer.shortenedNote"))).toBeNull();
    expectConsoleOutput();
  });

  it("reads the server's clock anew when its reading is older than a few seconds", async () => {
    const server = installFakeServer();
    publicLink(server);
    const { user } = renderApp(`/public/dashboards/${FAKE_TOKEN}`);
    const panel = await screen.findByRole("article", { name: "Orders" });
    expect(await within(panel).findByText("Krause")).toBeTruthy();
    // Later (the computer slept): the page's clock reading is old, and a refresh is refused.
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000);
    server.areas.sharing.clockOffsetMs = 60_000;
    server.areas.sharing.refuseWindow = 1;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        server.calls.filter((call) => call.path === `/api/public/dashboards/${FAKE_TOKEN}`),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(server.calls.filter((call) => call.path.includes("/panels/p1/query"))).toHaveLength(3),
    );
    expect(screen.queryByText(t("sharing.viewer.shortenedNote"))).toBeNull();
    expectConsoleOutput();
  });

  it("says so when a range had to be shortened to fit the window", async () => {
    const server = installFakeServer();
    publicLink(server);
    server.areas.sharing.refuseWindow = 2;
    renderApp(`/public/dashboards/${FAKE_TOKEN}`);
    const panel = await screen.findByRole("article", { name: "Orders" });
    expect(await within(panel).findByText("Krause")).toBeTruthy();
    expect(server.calls.filter((call) => call.path.includes("/panels/p1/query"))).toHaveLength(3);
    // Never half a range under the name of the whole one.
    expect(await screen.findByRole("button", { name: "Last 24 hours, shortened" })).toBeTruthy();
    expect(screen.getByText(t("sharing.viewer.shortenedNote"))).toBeTruthy();
    expectConsoleOutput();
  });

  it("shows the neutral message under /public for any other address too", async () => {
    installFakeServer();
    renderApp("/public/dashboards/");
    expect(
      await screen.findByRole("heading", { name: "This link is not available." }),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows one neutral message for an address that does not work", async () => {
    installFakeServer();
    renderApp("/public/dashboards/unknown-token");
    expect(
      await screen.findByRole("heading", { name: "This link is not available." }),
    ).toBeTruthy();
    // No reason, no way in: the visitor learns nothing else.
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.body.textContent).not.toMatch(/expired|revoked|suspended/i);
  });

  it("says in German what the board says", () => {
    expect(de("sharing.viewer.unavailable")).toBe("Dieser Link ist nicht verfügbar.");
  });

  it("shows a public snapshot frozen, with a panel that was left out", async () => {
    const server = installFakeServer();
    const now = Date.now();
    server.areas.sharing.publicSnapshots[FAKE_TOKEN] = {
      title: "Main, frozen",
      timeRange: { from: now - DAY_MS, to: now },
      createdAt: now,
      expiresAt: now + 30 * DAY_MS,
      dashboard: fakePublicDashboard({
        panels: [
          ...(fakePublicDashboard().panels as Record<string, unknown>[]),
          {
            id: "p2",
            type: "table",
            title: "Stock",
            grid: { x: 12, y: 0, w: 12, h: 8 },
            transparent: false,
            targets: [{ refId: "A", hide: false }],
            options: {},
            fieldConfig: {},
          },
        ],
      }),
      results: {
        p1: {
          results: {
            A: {
              result: {
                shape: "frame",
                frame: { fields: [{ name: "customer", type: "string", values: ["Hofmann"] }] },
              },
            },
          },
        },
      },
    };
    renderApp(`/public/snapshots/${FAKE_TOKEN}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Main, frozen" })).toBeTruthy();
    expect(await screen.findByText("Hofmann")).toBeTruthy();
    const left = screen.getByRole("article", { name: "Stock" });
    expect(within(left).getByText(t("sharing.viewer.notInSnapshot"))).toBeTruthy();
    // Viewing a snapshot asks no panel query.
    expect(server.calls.some((call) => call.path.includes("/query"))).toBe(false);
  });

  it("says that a frozen panel had no result when the snapshot was made", async () => {
    installFakeServer().areas.sharing.publicSnapshots[FAKE_TOKEN] = {
      title: "Main, frozen",
      timeRange: { from: Date.now() - DAY_MS, to: Date.now() },
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * DAY_MS,
      dashboard: fakePublicDashboard(),
      results: {
        p1: { results: { A: { error: { code: "datasource_error", message: "no value" } } } },
      },
    };
    renderApp(`/public/snapshots/${FAKE_TOKEN}`);
    const panel = await screen.findByRole("article", { name: "Orders" });
    expect(within(panel).getByText(t("sharing.viewer.noResultInSnapshot"))).toBeTruthy();
    // Frozen: nothing promises that it comes back.
    expect(within(panel).queryByText(t("sharing.viewer.panelUnavailable"))).toBeNull();
    expect(de("sharing.viewer.noResultInSnapshot")).toBe(
      "Beim Erstellen des Snapshots gab es hier kein Ergebnis.",
    );
  });

  it("hides the source's words when a public panel fails", async () => {
    const server = installFakeServer();
    publicLink(server);
    server.areas.sharing.panelAnswers.p1 = {
      results: { A: { error: { code: "datasource_error", message: "relation orders is gone" } } },
    };
    renderApp(`/public/dashboards/${FAKE_TOKEN}`);
    const panel = await screen.findByRole("article", { name: "Orders" });
    expect(await within(panel).findByText(t("sharing.viewer.panelUnavailable"))).toBeTruthy();
    expect(document.body.textContent).not.toContain("relation orders");
  });
});

describe("lists of shares", () => {
  function arrange(server: ReturnType<typeof installFakeServer>) {
    const now = Date.now();
    server.areas.sharing.links.push(
      fakeLink({ id: "l1", dashboardTitle: "Sales" }),
      fakeLink({
        id: "l2",
        dashboardTitle: "Stock",
        createdBy: "u2",
        createdByName: "Tim Berger",
        status: "suspended",
        suspendedReason: "creatorRights",
      }),
      fakeLink({ id: "l3", dashboardTitle: "Fair", status: "revoked", revokedAt: now }),
    );
    server.areas.sharing.snapshots.push(
      fakeSnapshot({ id: "s1", title: "Sales, today", dashboardTitle: "Sales" }),
    );
  }

  it("lists every link and snapshot for an organization admin, with status in words", async () => {
    const { user } = await openAdmin("/admin/shares", {
      permissions: ADMIN,
      setupServer: arrange,
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Shares" })).toBeTruthy();
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    const suspended = within(table).getByRole("row", { name: /Stock/ });
    expect(suspended.textContent).toContain("suspended");
    expect(suspended.textContent).toContain(t("sharing.suspended.creatorRights"));
    // A revoked one stays listed, muted, and can no longer be changed.
    const revoked = within(table).getByRole("row", { name: /Fair/ });
    expect(revoked.textContent).toContain("revoked");
    expect(within(revoked).queryByRole("button")).toBeNull();
    // Filters: only snapshots.
    await user.click(screen.getByRole("radio", { name: "Snapshots" }));
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByRole("row", { name: /Sales, today/ })).toBeTruthy();
  });

  it("is closed to people who are not organization admins", async () => {
    // Someone who may open the administration for roles, but does not manage the organization.
    await openAdmin("/admin/shares", {
      permissions: ["roles:read", "dashboards:read"],
      setupServer: arrange,
    });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the account's own shares under its settings, with the suspended ones named", async () => {
    await openAdmin("/settings/my-shares", {
      permissions: EDITOR,
      setupServer: (server) => {
        server.areas.sharing.links.push(
          fakeLink({ dashboardTitle: "Stock", status: "suspended", suspendedReason: "sharingOff" }),
        );
      },
    });
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("row", { name: /Stock/ })).toBeTruthy();
    // Without the creator column: all of them are one's own.
    expect(within(table).queryByRole("columnheader", { name: "Created by" })).toBeNull();
    expect(screen.getByText(/1 share is suspended/).textContent).toContain(
      t("sharing.suspended.sharingOff"),
    );
  });

  it("says where to start when nothing was shared", async () => {
    await openAdmin("/settings/my-shares", { permissions: EDITOR });
    expect(await screen.findByRole("heading", { name: "Nothing shared by you" })).toBeTruthy();
  });
});

describe("a snapshot in the organization", () => {
  it("opens in the app with its note and the way back to the live dashboard", async () => {
    const now = Date.now();
    await openAdmin("/dashboards/d-main/snapshots/s1", {
      permissions: EDITOR,
      setupServer: (server) => {
        server.areas.sharing.snapshotViews.s1 = {
          snapshot: fakeSnapshot({ title: "Main, frozen", createdByName: "Jonas Weber" }),
          dashboard: fakePublicDashboard(),
          results: {
            p1: {
              results: {
                A: {
                  result: {
                    shape: "frame",
                    frame: { fields: [{ name: "customer", type: "string", values: ["Hofmann"] }] },
                  },
                },
              },
            },
          },
        };
        void now;
      },
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Main, frozen" })).toBeTruthy();
    expect(await screen.findByText("Hofmann")).toBeTruthy();
    expect(screen.getByText(/by Jonas Weber, in the organization/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "To the live dashboard" }).getAttribute("href")).toBe(
      "/dashboards/d-main",
    );
  });

  it("says that a revoked or expired snapshot is gone", async () => {
    await openAdmin("/dashboards/d-main/snapshots/gone", { permissions: EDITOR });
    expect(await screen.findByRole("heading", { name: "This snapshot is gone" })).toBeTruthy();
    expectConsoleOutput();
  });
});
