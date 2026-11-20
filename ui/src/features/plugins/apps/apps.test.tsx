import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Registration } from "../../../auth/registrationApi";
import { type FakeServer, installFakeServer } from "../../../test/fakeServer";
import { openAdmin } from "../../admin/test/openAdmin";
import { SAMPLE_APP } from "../../settings/test/fake075";
import { fakePlugin } from "../test/fakePlugins";
import { APP_READY_MS } from "./AppPage";
import { appInitials } from "./api";
import { APP_BUDGET, answerAppRequest, parseAppMessage, requestBudget } from "./protocol";

const withApp = (server: FakeServer) => {
  server.areas.server075.apps.list.push(SAMPLE_APP);
  server.areas.server075.apps.settings.push({
    id: SAMPLE_APP.id,
    name: SAMPLE_APP.name,
    blocked: false,
    minRole: "viewer",
    capabilities: SAMPLE_APP.capabilities,
    usedBytes: 12_000,
  });
};

/** Sends a message as the app's frame would: from its window, with the opaque origin. */
function fromFrame(frame: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data, origin: "null", source: frame.contentWindow }),
    );
  });
}

/** The frame of the app's page (the sidebar's link carries the same title). */
async function appFrame(): Promise<HTMLIFrameElement> {
  await screen.findByText("App by Nordlicht Data");
  return document.querySelector("iframe.app-frame") as HTMLIFrameElement;
}

describe("app message API", () => {
  it("reads only messages of version 1 with a type, and requests with an id", () => {
    expect(parseAppMessage({ kalzit: "app", api: 1, type: "ready" })).toEqual({ kind: "ready" });
    expect(
      parseAppMessage({ kalzit: "app", api: 1, type: "storage.get", id: 7, key: "note" }),
    ).toEqual({
      kind: "request",
      request: { type: "storage.get", id: 7, payload: { key: "note" } },
    });
    expect(parseAppMessage({ kalzit: "app", api: 2, type: "ready" })).toBeNull();
    expect(parseAppMessage({ kalzit: "panel", api: 1, type: "ready" })).toBeNull();
    expect(parseAppMessage({ kalzit: "app", api: 1, type: "storage.get" })).toBeNull();
    expect(parseAppMessage("ready")).toBeNull();
    expect(appInitials("Capacity planning")).toBe("Ca");
  });

  it("refuses a request whose capability the manifest does not name, and unknown types", async () => {
    const app = { id: "a", capabilities: ["dashboards:read"] };
    await expect(
      answerAppRequest("o1", app, { type: "storage.put", id: 1, payload: { key: "k", value: 1 } }),
    ).rejects.toMatchObject({
      error: { code: "forbidden", reason: "plugin.app_capability_missing" },
    });
    await expect(
      answerAppRequest("o1", app, { type: "dashboards.delete", id: 2, payload: {} }),
    ).rejects.toMatchObject({ error: { code: "validation" } });
    await expect(
      answerAppRequest("o1", app, { type: "dashboards.get", id: 3, payload: {} }),
    ).rejects.toMatchObject({ error: { code: "validation" } });
  });
});

describe("app message API: what a page cannot reach", () => {
  const app = {
    id: "a",
    capabilities: ["dashboards:read", "analyses:read", "analyses:run", "storage"],
  };
  const ask = (type: string, payload: Record<string, unknown>) =>
    answerAppRequest("o1", app, { type, id: 1, payload });

  it("refuses ids that are no ids, so no address is resolved to another route", async () => {
    const server = installFakeServer({ signedIn: true });
    for (const bad of ["..", ".", "a/b", "a%2Fb", "", "x?y", "ä"]) {
      await expect(ask("analyses.run", { analysisId: bad })).rejects.toMatchObject({
        error: { code: "validation" },
      });
      await expect(ask("dashboards.get", { dashboardId: bad })).rejects.toMatchObject({
        error: { code: "validation" },
      });
    }
    // Nothing reached the server: not the analysis route, not the free query route it would
    // have resolved to.
    expect(server.calls).toEqual([]);
  });

  it("refuses storage keys with a dot part and keys outside the key alphabet", async () => {
    const server = installFakeServer({ signedIn: true });
    for (const bad of ["..", ".", "a/../b", "./a", "a b", "", "k".repeat(201)]) {
      await expect(ask("storage.get", { key: bad })).rejects.toMatchObject({
        error: { code: "validation", reason: "plugin.app_storage_key" },
      });
      await expect(ask("storage.put", { key: bad, value: 1 })).rejects.toMatchObject({
        error: { code: "validation" },
      });
    }
    expect(server.calls).toEqual([]);
  });

  it("knows only its own request types, not what every object has", async () => {
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await expect(ask(type, {})).rejects.toMatchObject({ error: { code: "validation" } });
    }
  });

  it("gives a page a budget of requests that refills with time", () => {
    let now = 0;
    const budget = requestBudget(() => now);
    let taken = 0;
    while (budget.take()) taken += 1;
    expect(taken).toBe(APP_BUDGET.burst);
    expect(budget.take()).toBe(false);
    now += 1000;
    taken = 0;
    while (budget.take()) taken += 1;
    expect(taken).toBe(APP_BUDGET.perSecond);
    // A long pause does not save up more than the burst.
    now += 3_600_000;
    taken = 0;
    while (budget.take()) taken += 1;
    expect(taken).toBe(APP_BUDGET.burst);
  });
});

describe("apps in the navigation", () => {
  it("refuses a page that asks too fast, and takes the page away once the app is blocked", async () => {
    const { server } = await openAdmin("/apps/dev.nordlicht.capacity/overview", {
      setupServer: withApp,
    });
    const frame = await appFrame();
    const posted: { replyTo?: number; error?: { code: string; reason?: string } }[] = [];
    const target = frame.contentWindow as Window;
    target.postMessage = ((data: never) => {
      posted.push(data);
    }) as typeof target.postMessage;
    fromFrame(frame, { kalzit: "app", api: 1, type: "ready" });
    for (let id = 1; id <= APP_BUDGET.burst + 5; id++) {
      fromFrame(frame, { kalzit: "app", api: 1, type: "storage.list", id });
    }
    await waitFor(() => expect(posted).toHaveLength(APP_BUDGET.burst + 5));
    expect(posted.filter((reply) => reply.error?.code === "rate_limited")).toHaveLength(5);

    // An organization admin blocks the app elsewhere: its next request is refused, the list of
    // apps is read again, and the page gives way to "not available".
    const setting = server.areas.server075.apps.settings[0];
    if (setting !== undefined) setting.blocked = true;
    await new Promise((resolve) => setTimeout(resolve, 600));
    fromFrame(frame, { kalzit: "app", api: 1, type: "storage.get", id: 900, key: "note" });
    expect(await screen.findByRole("heading", { name: "App not available" })).toBeTruthy();
    expect(document.querySelector("iframe.app-frame")).toBeNull();
  });

  it("shows one entry per app with its initials where the sidebar has no room for names", async () => {
    const { user } = await openAdmin("/", { setupServer: withApp });
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    await within(nav).findByRole("link", { name: "Capacity planning: Forecast" });
    await user.click(screen.getByRole("button", { name: "Sidebar" }));
    const entry = within(nav).getByRole("link", { name: "Capacity planning" });
    expect(entry.querySelector(".shell__app-mark")?.textContent).toBe("Ca");
    expect(within(nav).queryByRole("link", { name: "Capacity planning: Forecast" })).toBeNull();
    // It opens the app's first page; the others are in the app's bar.
    await user.click(entry);
    await appFrame();
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeTruthy();
  });

  it("shows no Apps section without an app", async () => {
    await openAdmin("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    expect(screen.queryByRole("heading", { name: "Apps" })).toBeNull();
  });

  it("lists an app's pages under Apps and opens one under Kalzit's bar", async () => {
    const { user } = await openAdmin("/", { setupServer: withApp });
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(await within(nav).findByRole("heading", { name: "Apps" })).toBeTruthy();
    await user.click(within(nav).getByRole("link", { name: "Capacity planning: Forecast" }));
    expect(await screen.findByText("App by Nordlicht Data")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Capacity planning / Forecast",
    );
    const frame = await appFrame();
    // Scripts only: no same-origin access, no forms, no popups; no network by the frame's policy.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(
      "/api/orgs/o1/apps/dev.nordlicht.capacity/pages/forecast/frame",
    );
    // What the app may do is one click away, with what it never gets.
    await user.click(screen.getByRole("button", { name: "About this app" }));
    const about = screen.getByRole("region", { name: "About this app" });
    expect(within(about).getByText("Read dashboards")).toBeTruthy();
    expect(within(about).getByText("Own storage, 50 MB per organization")).toBeTruthy();
    expect(within(about).getByText(/Never: passwords or tokens/)).toBeTruthy();
  });

  it("answers the page's requests through Kalzit's own routes, and only from its frame", async () => {
    const { server } = await openAdmin("/apps/dev.nordlicht.capacity/overview", {
      setupServer: withApp,
    });
    const frame = await appFrame();
    const posted: unknown[] = [];
    const target = frame.contentWindow as Window;
    target.postMessage = ((data: unknown) => {
      posted.push(data);
    }) as typeof target.postMessage;
    fromFrame(frame, { kalzit: "app", api: 1, type: "ready" });
    fromFrame(frame, {
      kalzit: "app",
      api: 1,
      type: "storage.put",
      id: 1,
      key: "note:d1",
      value: "hi",
    });
    await waitFor(() =>
      expect(posted).toContainEqual({ kalzit: "app", api: 1, replyTo: 1, result: null }),
    );
    expect(server.areas.server075.apps.storage).toEqual({ "note:d1": "hi" });
    fromFrame(frame, { kalzit: "app", api: 1, type: "storage.get", id: 2, key: "note:d1" });
    await waitFor(() =>
      expect(posted).toContainEqual(
        expect.objectContaining({ replyTo: 2, result: expect.objectContaining({ value: "hi" }) }),
      ),
    );
    // The manifest names no analyses: the request is refused, nothing is asked of the server.
    fromFrame(frame, { kalzit: "app", api: 1, type: "analyses.list", id: 3 });
    await waitFor(() =>
      expect(posted).toContainEqual(
        expect.objectContaining({
          replyTo: 3,
          error: expect.objectContaining({ reason: "plugin.app_capability_missing" }),
        }),
      ),
    );
    expect(server.calls.some((call) => call.path.includes("/analyses"))).toBe(false);
    // A message from another window, or with a real origin, is not the app's.
    const before = posted.length;
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { kalzit: "app", api: 1, type: "storage.get", id: 4, key: "note:d1" },
          origin: "https://elsewhere.example",
          source: frame.contentWindow,
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { kalzit: "app", api: 1, type: "storage.get", id: 5, key: "note:d1" },
          origin: "null",
          source: window,
        }),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toHaveLength(before);
  });

  it("says when a page does not answer and loads it again on request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user } = await openAdmin("/apps/dev.nordlicht.capacity/overview", {
        setupServer: withApp,
      });
      const frame = await appFrame();
      expect(frame.getAttribute("aria-busy")).toBe("true");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(APP_READY_MS + 100);
      });
      const alert = await waitFor(() => {
        const found = document.querySelector<HTMLElement>(".app-host__notice");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      expect(alert.textContent).toContain("The app does not answer.");
      expect(alert.textContent).toContain("Your dashboards are not affected.");
      await user.click(within(alert).getByRole("button", { name: "Try again" }));
      expect(document.querySelector(".app-host__notice")).toBeNull();
      // A new frame: the page loads afresh.
      expect(await appFrame()).not.toBe(frame);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says an app is not available here instead of an empty page", async () => {
    await openAdmin("/apps/dev.unknown.app/page");
    expect(await screen.findByRole("heading", { name: "App not available" })).toBeTruthy();
    expect(screen.getByText("This app is not available here.")).toBeTruthy();
  });
});

describe("Verwaltung > Apps", () => {
  it("blocks an app and limits it to a role, at once and with undo", async () => {
    const { user, server } = await openAdmin("/settings/org-apps", { setupServer: withApp });
    const card = await screen.findByRole("region", { name: "Capacity planning" });
    expect(within(card).getByText("12 kB of its storage used")).toBeTruthy();
    const role = within(card).getByRole("combobox", { name: "Who sees the app" });
    await user.click(role);
    await user.click(screen.getByRole("option", { name: "Editor and up" }));
    const setting = () => server.areas.server075.apps.settings[0];
    await waitFor(() => expect(setting()?.minRole).toBe("editor"));
    expect(await screen.findByText("Capacity planning: from Editor up")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(setting()?.minRole).toBe("viewer"));

    await user.click(within(card).getByRole("switch", { name: "Block for this organization" }));
    await waitFor(() => expect(setting()?.blocked).toBe(true));
    // A blocked app leaves the navigation at once.
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Capacity planning: Overview" })).toBeNull(),
    );
  });

  it("says where apps come from while none is installed", async () => {
    await openAdmin("/settings/org-apps");
    expect(await screen.findByRole("heading", { name: "No apps installed" })).toBeTruthy();
  });
});

describe("apps among the plugins", () => {
  const app = fakePlugin({
    id: "dev.nordlicht.capacity",
    name: "Capacity planning",
    kind: "app",
    appCapabilities: ["dashboards:read", "storage"],
    appPages: [
      { id: "overview", title: { en: "Overview" }, path: "overview.js" },
      { id: "forecast", title: { en: "Forecast" }, path: "forecast.js" },
    ],
  });

  it("lists an app as its own kind and shows its pages and what it may do", async () => {
    const { user } = await openAdmin("/settings/plugins", {
      isServerAdmin: true,
      setupServer: (server) => {
        server.areas.plugins.plugins.push(app);
      },
    });
    const filter = await screen.findByRole("button", { name: /^Apps 1$/ });
    await user.click(filter);
    const row = screen.getByRole("row", { name: /Capacity planning/ });
    expect(within(row).getByText("App")).toBeTruthy();
    await user.click(
      within(row).getAllByRole("link", { name: /Capacity planning/ })[0] as HTMLElement,
    );
    expect(await screen.findByText("Forecast")).toBeTruthy();
    // The app's texts load with the app area, after the page itself: waited for, not read.
    expect((await screen.findAllByText("Read dashboards")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/without a process on the server/)).toBeTruthy();
    // No log and no "used in" for an app.
    expect(screen.queryByRole("tab", { name: "Log" })).toBeNull();
  });
});

describe("requests above the members", () => {
  const request = (fields: Partial<Registration>): Registration => ({
    id: "r1",
    email: "jonas@example.com",
    name: "Jonas Keller",
    status: "pending",
    // As the server answers a waiting request: no organization and no role before the decision.
    orgId: null,
    role: null,
    createdAt: Date.UTC(2026, 10, 14, 9),
    expiresAt: Date.UTC(2026, 10, 28, 9),
    confirmedAt: Date.UTC(2026, 10, 14, 9, 14),
    ...fields,
  });
  const withRequests = (server: FakeServer) => {
    server.areas.server075.registration.requests.push(
      request({}),
      request({ id: "r2", name: "Ela Kaya", email: "e.kaya@partner.example" }),
    );
  };

  it("approves a request with a role and declines one after asking", async () => {
    const { user, server } = await openAdmin("/admin/members", {
      isServerAdmin: true,
      setupServer: withRequests,
    });
    const card = await screen.findByRole("region", { name: /Requests/ });
    const rows = within(card).getAllByRole("row");
    expect(rows).toHaveLength(3);
    await user.click(
      within(rows[1] as HTMLElement).getByRole("combobox", { name: "Role for Jonas Keller" }),
    );
    await user.click(screen.getByRole("option", { name: "Editor" }));
    await user.click(within(rows[1] as HTMLElement).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Jonas Keller is a member now and gets a mail.")).toBeTruthy();
    expect(server.areas.server075.registration.decisions).toEqual(["approve r1 editor into o1"]);

    const left = within(await screen.findByRole("region", { name: /Requests/ })).getAllByRole(
      "row",
    );
    await user.click(within(left[1] as HTMLElement).getByRole("button", { name: "Refuse" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Decline the request of Ela Kaya?",
    });
    // Focus starts on Cancel, so Enter does not decline.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Refuse" }));
    await waitFor(() =>
      expect(server.areas.server075.registration.decisions).toEqual([
        "approve r1 editor into o1",
        "reject r2",
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: /Requests/ })).toBeNull());
  });

  it("approves into the organization of the page, with the configured default role", async () => {
    const { user, server } = await openAdmin("/admin/members", {
      isServerAdmin: true,
      setupServer: withRequests,
      setup: (admin) =>
        admin.serverSettings.push({
          key: "registration.default_role",
          scope: "server",
          value: "editor",
          default: "viewer",
          source: "database",
          editable: true,
          version: 1,
          description: "registration.default_role",
          updatedAt: null,
          updatedBy: null,
        }),
    });
    const card = await screen.findByRole("region", { name: /Requests/ });
    expect(within(card).getByText(/Whoever you approve joins this organization\./)).toBeTruthy();
    const row = within(card).getAllByRole("row")[1] as HTMLElement;
    const role = within(row).getByRole("combobox", { name: "Role for Jonas Keller" });
    await waitFor(() => expect(role.textContent).toContain("Editor"));
    await user.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(server.areas.server075.registration.decisions).toEqual(["approve r1 editor into o1"]),
    );
    const call = server.calls.find((c) => c.path.endsWith("/registrations/r1/approve"));
    expect(call?.body).toEqual({ orgId: "o1", role: "editor" });
  });

  it("shows no requests to an organization admin, who cannot decide them", async () => {
    const { server } = await openAdmin("/admin/members", { setupServer: withRequests });
    await screen.findByRole("table", { name: "Members" });
    expect(screen.queryByRole("region", { name: /Requests/ })).toBeNull();
    expect(server.calls.some((call) => call.path.includes("/admin/registrations"))).toBe(false);
  });
});
