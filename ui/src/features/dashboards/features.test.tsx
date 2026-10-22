import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { type DashboardModel, emptyModel, type PanelModel } from "./model";
import { addDashboard, addFolder, latest, type StoredDashboard } from "./test/fakeDashboards";

/**
 * The dashboard power features (docs/api/dashboard-features.md) through the whole app against the
 * fake server: rows, repeats, annotations, links, panel time options, view modes, playlists,
 * library panels, the JSON model, import and export, copying panels and "save as".
 */

async function fill(user: ReturnType<typeof renderApp>["user"], field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

async function replace(
  user: ReturnType<typeof renderApp>["user"],
  field: HTMLElement,
  text: string,
) {
  await user.clear(field);
  await user.paste(text);
}

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function panel(id: string, title: string, extra: Partial<PanelModel> = {}): PanelModel {
  return {
    id,
    type: "table",
    title,
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: `SELECT * FROM ${id}` } }],
    transformations: [],
    options: {},
    fieldConfig: {},
    ...extra,
  };
}

function setup(role: string, model: DashboardModel) {
  const server = installFakeServer({ signedIn: true, user: asRole(role) });
  addFolder(server.areas.dashboards, "f-ops", "Operations");
  const stored = addDashboard(server.areas.dashboards, "d-main", model, { folderId: "f-ops" });
  return { server, stored };
}

const article = (name: string | RegExp) => screen.getByRole("article", { name });

async function saveDashboard(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(screen.getByRole("button", { name: "Save…" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
      name: "Save",
    }),
  );
}

describe("rows", () => {
  const withRows = (): DashboardModel => ({
    ...emptyModel("Main"),
    rows: [
      { id: "r1", title: "Details", collapsed: true },
      { id: "r2", title: "Costs", collapsed: false },
    ],
    panels: [
      panel("top", "Overview"),
      panel("p1", "Orders", { rowId: "r1" }),
      panel("p2", "Spend", { rowId: "r2" }),
    ],
  });

  it("opens and closes rows for viewers without saving, saved collapsed rows start closed", async () => {
    const { server } = setup("viewer", withRows());
    const { user } = renderApp("/dashboards/d-main");
    await screen.findByRole("article", { name: "Overview" });
    expect(screen.queryByRole("article", { name: "Orders" })).toBeNull();
    // A collapsed row's panels do not query.
    await waitFor(() => expect(server.areas.dashboards.panelQueries.length).toBeGreaterThan(0));
    expect(server.areas.dashboards.panelQueries.map((q) => q.panelId)).not.toContain("p1");
    const details = screen.getByRole("button", { name: /^Details/ });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    await user.click(details);
    expect(await screen.findByRole("article", { name: "Orders" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Costs" }));
    expect(screen.queryByRole("article", { name: "Spend" })).toBeNull();
    // Viewing changes nothing on the server.
    expect(server.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("adds a row, moves rows with the keyboard and saves their order and state", async () => {
    const { server, stored } = setup("editor", withRows());
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Add row" }));
    const handle = screen.getByRole("button", { name: "Move row “Details”" });
    // The way to move it is read with the handle, not only shown on hover.
    const hint = document.getElementById(handle.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe(
      "Drag, or use the up and down arrow keys, to move the row with its panels.",
    );
    handle.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByText("Row “Details” is now at position 2 of 3.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move row “Details”" }));
    // Collapsing in edit mode is saved.
    await user.click(screen.getByRole("button", { name: "Costs" }));
    await saveDashboard(user);
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    const rows = latest(stored).model.rows ?? [];
    expect(rows.map((r) => [r.title, r.collapsed])).toEqual([
      ["Costs", true],
      ["Details", true],
      ["Row 3", false],
    ]);
    expect(server.calls.at(-1)?.method).not.toBe("POST");
  });

  it("removes a row and keeps its panels", async () => {
    const { stored } = setup("editor", withRows());
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Remove row “Details”" }));
    const dialog = screen.getByRole("dialog", { name: "Remove row?" });
    expect(within(dialog).getByText(/Its 1 panels stay/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Remove row" }));
    expect(await screen.findByRole("article", { name: "Orders" })).toBeTruthy();
    await saveDashboard(user);
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    const saved = latest(stored).model;
    expect(saved.rows?.map((r) => r.id)).toEqual(["r2"]);
    expect(saved.panels.find((p) => p.id === "p1")).not.toHaveProperty("rowId");
  });
});

describe("repeats", () => {
  it("shows a panel once per selected value, each querying with its own value", async () => {
    const model: DashboardModel = {
      ...emptyModel("Main"),
      variables: [
        {
          name: "land",
          type: "custom",
          options: ["at", "de", "ch"],
          current: ["at", "de"],
          multi: true,
        },
      ],
      panels: [panel("p1", "Orders", { repeat: { variable: "land", direction: "horizontal" } })],
    };
    const { server } = setup("viewer", model);
    const { user } = renderApp("/dashboards/d-main");
    expect(await screen.findByRole("article", { name: "Orders: at" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Orders: de" })).toBeTruthy();
    await waitFor(() => expect(server.areas.dashboards.panelQueries.length).toBe(2));
    const sent = server.areas.dashboards.panelQueries.map((q) => q.body.variables.land).sort();
    expect(sent).toEqual(["at", "de"]);

    // Picking a third value adds a copy.
    const select = screen.getByRole("listbox", { name: "land" });
    await user.selectOptions(select, ["at", "de", "ch"]);
    expect(await screen.findByRole("article", { name: "Orders: ch" })).toBeTruthy();
  });

  it("repeats a whole row per value", async () => {
    const model: DashboardModel = {
      ...emptyModel("Main"),
      variables: [
        { name: "land", type: "custom", options: ["at", "de"], current: ["at", "de"], multi: true },
      ],
      rows: [{ id: "r1", title: "Land", collapsed: false, repeat: { variable: "land" } }],
      panels: [panel("p1", "Orders", { rowId: "r1" })],
    };
    setup("viewer", model);
    renderApp("/dashboards/d-main");
    expect(await screen.findByRole("region", { name: "Land: at" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Land: de" })).toBeTruthy();
    expect(screen.getAllByRole("article", { name: /Orders/ })).toHaveLength(2);
  });

  it("sets a repeat in the panel editor for a multi-value variable only", async () => {
    const model: DashboardModel = {
      ...emptyModel("Main"),
      variables: [
        { name: "land", type: "custom", options: ["at"], multi: true },
        { name: "one", type: "custom", options: ["x"] },
      ],
      panels: [panel("p1", "Orders")],
    };
    const { stored } = setup("editor", model);
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(article("Orders")).getByRole("button", { name: "Edit “Orders”" }));
    const dialog = screen.getByRole("dialog", { name: "Edit panel" });
    const repeat = within(dialog).getByRole("combobox", { name: "Repeat for each value of" });
    expect(within(repeat).queryByRole("option", { name: "one" })).toBeNull();
    await user.selectOptions(repeat, "land");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Copies" }), "vertical");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    await saveDashboard(user);
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    expect(latest(stored).model.panels[0]?.repeat).toEqual({
      variable: "land",
      direction: "vertical",
    });
  });
});

describe("annotations", () => {
  const timeModel = (): DashboardModel => ({
    ...emptyModel("Main"),
    panels: [
      {
        ...panel("p1", "Load"),
        type: "timeseries",
        targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT time, load FROM t" } }],
      },
    ],
  });

  it("shows written annotations on time panels and lets writers add one", async () => {
    const { server } = setup("editor", timeModel());
    server.areas.dashboardFeatures.annotations.push({
      id: "a1",
      dashboardId: "d-main",
      panelId: null,
      time: Date.now() - 3_600_000,
      timeEnd: null,
      text: "Release 2.1",
      tags: ["deploy"],
      version: 1,
    });
    const { user } = renderApp("/dashboards/d-main");
    const mark = await screen.findByRole("button", { name: /Annotation at .*: Release 2\.1/ });
    await user.click(mark);
    let dialog = screen.getByRole("dialog", { name: "Change annotation" });
    expect(within(dialog).getByRole("textbox", { name: "Text" })).toHaveProperty(
      "value",
      "Release 2.1",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await user.click(within(article("Load")).getByRole("button", { name: "Annotate “Load”" }));
    dialog = screen.getByRole("dialog", { name: "Add annotation" });
    await fill(user, within(dialog).getByRole("textbox", { name: "Text" }), "Wartung");
    await fill(user, within(dialog).getByRole("textbox", { name: /Tags/ }), "ops, nacht");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.dashboardFeatures.annotations).toHaveLength(2));
    const added = server.areas.dashboardFeatures.annotations[1];
    expect(added).toMatchObject({ text: "Wartung", tags: ["ops", "nacht"], panelId: "p1" });
    expect(await screen.findByRole("button", { name: /Annotation at .*: Wartung/ })).toBeTruthy();
  });

  it("adds an annotation with the A key in the chart's keyboard readout", async () => {
    const { server } = setup("editor", timeModel());
    const { user } = renderApp("/dashboards/d-main");
    const plot = await within(await screen.findByRole("article", { name: "Load" })).findByRole(
      "group",
      {
        name: "Load",
      },
    );
    plot.focus();
    await user.keyboard("a");
    const dialog = await screen.findByRole("dialog", { name: "Add annotation" });
    await fill(user, within(dialog).getByRole("textbox", { name: "Text" }), "Spitze");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.dashboardFeatures.annotations).toHaveLength(1));
    // The keyboard readout starts in the middle of the plot: the annotation is at the middle
    // of the panel's range, to the millisecond the chart computed, not rounded to a minute.
    const range = server.areas.dashboards.panelQueries[0]?.body.timeRange ?? { from: 0, to: 0 };
    const added = server.areas.dashboardFeatures.annotations[0];
    expect(Math.abs((added?.time ?? 0) - (range.from + range.to) / 2)).toBeLessThan(1000);
  });

  it("adds an annotation where Ctrl+click points on the chart", async () => {
    const { server } = setup("editor", timeModel());
    renderApp("/dashboards/d-main");
    const plot = await within(await screen.findByRole("article", { name: "Load" })).findByRole(
      "group",
      { name: "Load" },
    );
    // At the plot's left edge (the value axis ends there; a click on the axis counts as the edge).
    fireEvent.click(plot, { ctrlKey: true, clientX: 56 });
    const dialog = await screen.findByRole("dialog", { name: "Add annotation" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Text" }), {
      target: { value: "Klick" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.dashboardFeatures.annotations).toHaveLength(1));
    const range = server.areas.dashboards.panelQueries[0]?.body.timeRange ?? { from: 0, to: 0 };
    const added = server.areas.dashboardFeatures.annotations[0];
    expect(Math.abs((added?.time ?? 0) - range.from)).toBeLessThan(1000);
    // A plain click only focuses the chart.
    fireEvent.click(plot, { clientX: 56 });
    expect(screen.queryByRole("dialog", { name: "Add annotation" })).toBeNull();
  });

  it("shows a shifted panel's annotations, which lie outside the dashboard's range", async () => {
    const model = timeModel();
    const shifted = { ...(model.panels[0] as PanelModel), timeShift: "1d" };
    model.panels = [shifted];
    const { server } = setup("editor", model);
    const { user } = renderApp("/dashboards/d-main");
    const plot = await within(await screen.findByRole("article", { name: "Load" })).findByRole(
      "group",
      { name: "Load" },
    );
    plot.focus();
    await user.keyboard("a");
    const dialog = await screen.findByRole("dialog", { name: "Add annotation" });
    await fill(user, within(dialog).getByRole("textbox", { name: "Text" }), "Gestern");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.dashboardFeatures.annotations).toHaveLength(1));
    // A day back: before the dashboard's own range starts, and still drawn on the panel.
    expect(server.areas.dashboardFeatures.annotations[0]?.time ?? 0).toBeLessThan(
      Date.now() - 20 * 3_600_000,
    );
    expect(await screen.findByRole("button", { name: /Annotation at .*: Gestern/ })).toBeTruthy();
  });

  it("keeps a stored time's precision and retries after someone else changed it", async () => {
    const { server } = setup("editor", timeModel());
    const exact = Date.now() - 3_600_000 + 123;
    server.areas.dashboardFeatures.annotations.push({
      id: "a1",
      dashboardId: "d-main",
      panelId: null,
      time: exact,
      timeEnd: null,
      text: "Release",
      tags: [],
      version: 1,
    });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: /Annotation at .*: Release/ }));
    let dialog = screen.getByRole("dialog", { name: "Change annotation" });
    // Someone else changes it meanwhile.
    const stored = server.areas.dashboardFeatures.annotations[0];
    if (stored !== undefined) {
      stored.text = "Release 2";
      stored.version = 2;
    }
    await replace(user, within(dialog).getByRole("textbox", { name: "Text" }), "Release 1.1");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/The dialog now shows what is stored/)).toBeTruthy();
    expect(within(dialog).getByRole("textbox", { name: "Text" })).toHaveProperty(
      "value",
      "Release 2",
    );
    await replace(user, within(dialog).getByRole("textbox", { name: "Text" }), "Release 2.1");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.dashboardFeatures.annotations[0]?.version).toBe(3));
    const patch = server.calls.filter((c) => c.method === "PATCH").at(-1);
    // Only the text changed: no time is sent, so the stored one keeps its milliseconds.
    expect(patch?.body).toEqual({ version: 2, text: "Release 2.1", tags: [] });
    expect(server.areas.dashboardFeatures.annotations[0]?.time).toBe(exact);
    dialog = screen.queryByRole("dialog", { name: "Change annotation" }) as HTMLElement;
    expect(dialog).toBeNull();
  });

  it("shows annotations read-only to viewers, and nothing to add", async () => {
    const { server } = setup("viewer", timeModel());
    server.areas.dashboardFeatures.annotations.push({
      id: "a1",
      dashboardId: "d-main",
      panelId: null,
      time: Date.now() - 3_600_000,
      timeEnd: null,
      text: "Release",
      tags: [],
      version: 1,
    });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: /Annotation at .*: Release/ }));
    const dialog = screen.getByRole("dialog", { name: "Annotation" });
    expect(within(dialog).getByText("Release")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("button", { name: /^Annotate/ })).toBeNull();
  });

  it("reads the dashboard's own range first, so a wide panel range never crowds it out", async () => {
    const model = timeModel();
    const wide = {
      ...(model.panels[0] as PanelModel),
      id: "p2",
      title: "Monat",
      timeFrom: "now-30d",
    };
    model.panels = [...model.panels, { ...wide, grid: { x: 12, y: 0, w: 12, h: 8 } }];
    const { server } = setup("viewer", model);
    const old = Date.now() - 20 * 24 * 3_600_000;
    for (let i = 0; i < 1100; i++) {
      server.areas.dashboardFeatures.annotations.push({
        id: `old-${String(i).padStart(4, "0")}`,
        dashboardId: "d-main",
        panelId: "p2",
        time: old + i,
        timeEnd: null,
        text: `Alt ${i}`,
        tags: [],
        version: 1,
      });
    }
    server.areas.dashboardFeatures.annotations.push({
      id: "recent",
      dashboardId: "d-main",
      panelId: null,
      time: Date.now() - 3_600_000,
      timeEnd: null,
      text: "Neueste",
      tags: [],
      version: 1,
    });
    renderApp("/dashboards/d-main");
    const load = await screen.findByRole("article", { name: "Load" });
    expect(
      await within(load).findByRole("button", { name: /Annotation at .*: Neueste/ }),
    ).toBeTruthy();
    // The wide panel's own range was read on its own, and found its old marks too.
    expect(
      await within(screen.getByRole("article", { name: "Monat" })).findAllByRole("button", {
        name: /Annotation at .*: Alt/,
      }),
    ).not.toHaveLength(0);
    const ranges = new Set(
      server.areas.dashboardFeatures.annotationListRequests.map((r) => r.to - r.from),
    );
    expect(ranges).toEqual(new Set([6 * 3_600_000, 30 * 24 * 3_600_000]));
  });

  it("asks for annotation times to the second, and keeps a new mark's exact time", async () => {
    setup("editor", timeModel());
    const { user } = renderApp("/dashboards/d-main");
    await user.click(
      within(await screen.findByRole("article", { name: "Load" })).getByRole("button", {
        name: "Annotate “Load”",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Add annotation" });
    const time = within(dialog).getByLabelText("Time");
    expect(time.getAttribute("step")).toBe("1");
    expect((time as HTMLInputElement).value).toMatch(/T\d{2}:\d{2}:\d{2}$/);
    await user.click(within(dialog).getByRole("checkbox", { name: "Spans a period of time" }));
    expect(within(dialog).getByLabelText("End").getAttribute("step")).toBe("1");
  });

  it("runs annotation queries through the dashboard and draws their rows", async () => {
    const model = timeModel();
    model.annotations = [
      {
        id: "rel",
        name: "Releases",
        datasourceId: PG_ID,
        query: { sql: "SELECT time FROM releases" },
        enabled: true,
      },
      {
        id: "off",
        name: "Off",
        datasourceId: PG_ID,
        query: { sql: "SELECT time FROM x" },
        enabled: false,
      },
    ];
    const { server } = setup("viewer", model);
    renderApp("/dashboards/d-main");
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /Annotation at .*: Releases/ }).length,
      ).toBeGreaterThan(0),
    );
    expect(server.areas.dashboardFeatures.annotationQueryRequests.map((r) => r.queryId)).toEqual([
      "rel",
    ]);
  });
});

describe("links", () => {
  it("fills variables into dashboard and data links and drops links that would not be safe", async () => {
    const model: DashboardModel = {
      ...emptyModel("Main"),
      variables: [{ name: "land", type: "custom", options: ["at", "de"] }],
      links: [
        { type: "url", title: "Wiki", url: "https://wiki.example/$land" },
        // Stored by an older or foreign client; the browser checks again after filling in.
        { type: "url", title: "Evil", url: "javascript:alert(1)" },
        { type: "dashboards", tag: "sales", title: "More sales" },
      ],
      panels: [
        panel("p1", "Orders", {
          links: [{ title: "Details", url: "/dashboards/x?land=$land", newTab: true }],
        }),
      ],
    };
    const { server } = setup("viewer", model);
    addDashboard(server.areas.dashboards, "d-other", {
      ...emptyModel("Sales EU"),
      tags: ["Sales"],
    });
    const { user } = renderApp("/dashboards/d-main");
    const wiki = await screen.findByRole("link", { name: "Wiki" });
    expect(wiki.getAttribute("href")).toBe("https://wiki.example/at");
    expect(screen.queryByRole("link", { name: "Evil" })).toBeNull();
    const details = within(article("Orders")).getByRole("link", { name: "Details" });
    expect(details.getAttribute("href")).toBe("/dashboards/x?land=at");
    expect(details.getAttribute("target")).toBe("_blank");
    expect(details.getAttribute("rel")).toBe("noopener noreferrer");
    await user.selectOptions(screen.getByRole("combobox", { name: "land" }), "de");
    expect(screen.getByRole("link", { name: "Wiki" }).getAttribute("href")).toBe(
      "https://wiki.example/de",
    );
    await user.click(screen.getByText("More sales"));
    expect(await screen.findByRole("link", { name: "Sales EU" })).toBeTruthy();
  });

  it("refuses a link address that is not web, mail or local in the settings", async () => {
    const { stored } = setup("editor", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Settings…" }));
    const dialog = screen.getByRole("dialog", { name: "Dashboard settings" });
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));
    await fill(user, within(dialog).getByRole("textbox", { name: "Label" }), "Böse");
    await replace(
      user,
      within(dialog).getByRole("textbox", { name: /^Address/ }),
      "javascript:alert(1)",
    );
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(
      within(dialog).getByText("The address must start with https://, http://, mailto: or /."),
    ).toBeTruthy();
    await replace(
      user,
      within(dialog).getByRole("textbox", { name: /^Address/ }),
      "https://kalzit.example/",
    );
    await fill(user, within(dialog).getByRole("textbox", { name: /^Tags/ }), "sales, eu");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    await saveDashboard(user);
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    expect(latest(stored).model.links).toEqual([
      { type: "url", title: "Böse", url: "https://kalzit.example/" },
    ]);
    expect(latest(stored).model.tags).toEqual(["sales", "eu"]);
  });
});

describe("panel time options", () => {
  it("queries a panel with its own range and shift and says so in its header", async () => {
    const model: DashboardModel = {
      ...emptyModel("Main"),
      panels: [panel("p1", "Orders", { timeFrom: "now-24h", timeShift: "1d" })],
    };
    const { server } = setup("viewer", model);
    renderApp("/dashboards/d-main");
    const card = await screen.findByRole("article", { name: "Orders" });
    expect(within(card).getByText("Last 24h, shifted by 1d")).toBeTruthy();
    await waitFor(() => expect(server.areas.dashboards.panelQueries).toHaveLength(1));
    const { from, to } = server.areas.dashboards.panelQueries[0]?.body.timeRange ?? {
      from: 0,
      to: 0,
    };
    expect(to - from).toBe(24 * 3_600_000);
    expect(Date.now() - to).toBeGreaterThanOrEqual(23 * 3_600_000);
  });

  it("refuses an own range that is not relative to now", async () => {
    setup("editor", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(article("Orders")).getByRole("button", { name: "Edit “Orders”" }));
    const dialog = screen.getByRole("dialog", { name: "Edit panel" });
    await fill(user, within(dialog).getByRole("textbox", { name: /Own time range/ }), "yesterday");
    expect(within(dialog).getByText(/Enter a range relative to now/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true);
  });
});

describe("view modes", () => {
  it("hides the chrome in kiosk mode and leaves it with Escape", async () => {
    setup("viewer", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
    const { user, location } = renderApp("/dashboards/d-main?kiosk=kiosk");
    expect(await screen.findByRole("article", { name: "Orders" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Main" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(location().search).not.toHaveProperty("kiosk"));
    expect(await screen.findByRole("heading", { level: 1, name: "Main" })).toBeTruthy();
  });

  it("offers a visible way out of kiosk mode to mouse and touch, hidden when idle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup("viewer", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
      const { user, location } = renderApp("/dashboards/d-main?kiosk=kiosk");
      const exit = await screen.findByRole("button", { name: "Leave full screen" });
      const view = exit.closest(".dashboard") as HTMLElement;
      expect(view.classList.contains("dashboard--idle")).toBe(false);
      vi.advanceTimersByTime(5000);
      await waitFor(() => expect(view.classList.contains("dashboard--idle")).toBe(true));
      fireEvent.pointerDown(window);
      await waitFor(() => expect(view.classList.contains("dashboard--idle")).toBe(false));
      await user.click(exit);
      await waitFor(() => expect(location().search).not.toHaveProperty("kiosk"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("enters TV mode from the menu and hides the controls after a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup("viewer", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
      const { user, location } = renderApp("/dashboards/d-main");
      await user.click(await screen.findByText("More"));
      await user.click(screen.getByRole("button", { name: "TV mode" }));
      await waitFor(() => expect(location().search).toMatchObject({ kiosk: "tv" }));
      const bar = screen
        .getByRole("button", { name: "Leave full screen" })
        .closest(".dashboard") as HTMLElement;
      expect(bar.classList.contains("dashboard--idle")).toBe(false);
      vi.advanceTimersByTime(5000);
      await waitFor(() => expect(bar.classList.contains("dashboard--idle")).toBe(true));
      fireEvent.pointerMove(window);
      await waitFor(() => expect(bar.classList.contains("dashboard--idle")).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows one panel alone and returns", async () => {
    setup("viewer", {
      ...emptyModel("Main"),
      panels: [panel("p1", "Orders"), panel("p2", "Spend", { grid: { x: 12, y: 0, w: 12, h: 8 } })],
    });
    const { user, location } = renderApp("/dashboards/d-main");
    await user.click(
      within(await screen.findByRole("article", { name: "Orders" })).getByRole("button", {
        name: "View “Orders” alone",
      }),
    );
    await waitFor(() => expect(location().search).toMatchObject({ viewPanel: "p1" }));
    expect(screen.queryByRole("article", { name: "Spend" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to the dashboard" }));
    expect(await screen.findByRole("article", { name: "Spend" })).toBeTruthy();
  });
});

describe("playlists", () => {
  it("creates a playlist and plays it, stepping through the dashboards", async () => {
    const { server } = setup("editor", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
    addDashboard(server.areas.dashboards, "d-second", { ...emptyModel("Second"), tags: ["wall"] });
    const { user, location } = renderApp("/dashboards/playlists");
    await user.click(await screen.findByRole("button", { name: "New playlist" }));
    const dialog = screen.getByRole("dialog", { name: "New playlist" });
    await fill(user, within(dialog).getByRole("textbox", { name: "Name" }), "Empfang");
    await user.click(await within(dialog).findByRole("button", { name: "Add “Main”" }));
    await fill(user, within(dialog).getByRole("textbox", { name: "Tag" }), "wall");
    await user.click(within(dialog).getByRole("button", { name: "Add tag" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.dashboardFeatures.playlists).toHaveLength(1));
    expect(server.areas.dashboardFeatures.playlists[0]).toMatchObject({
      name: "Empfang",
      intervalSeconds: 60,
      items: [
        { type: "dashboard", dashboardId: "d-main" },
        { type: "tag", tag: "wall" },
      ],
    });

    await user.click(await screen.findByRole("link", { name: "Play “Empfang”" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Main" })).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Second" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/playlists"));
  });

  it("lets viewers play but not change playlists", async () => {
    const { server } = setup("viewer", emptyModel("Main"));
    server.areas.dashboardFeatures.playlists.push({
      id: "pl1",
      name: "Wand",
      intervalSeconds: 30,
      items: [{ type: "dashboard", dashboardId: "d-main" }],
      version: 1,
    });
    renderApp("/dashboards/playlists");
    expect(await screen.findByRole("link", { name: "Play “Wand”" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New playlist" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change “Wand”" })).toBeNull();
  });
});

describe("library panels", () => {
  function withLibrary(server: ReturnType<typeof setup>["server"]) {
    server.areas.dashboardFeatures.libraryPanels.push({
      id: "lib-1",
      folderId: null,
      name: "Revenue per day",
      model: {
        schemaVersion: 2,
        type: "table",
        title: "Revenue",
        targets: [
          { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT amount FROM revenue" } },
        ],
        // Content a slot must not copy: the slot shape below would show it.
        options: { unit: "EUR" },
        fieldConfig: { decimals: 2 },
        transformations: [{ type: "filter" }],
        links: [{ title: "More", url: "/dashboards" }],
      },
      version: 1,
    });
  }

  it("adds a library panel; the dashboard stores only the reference and draws its content", async () => {
    const { server, stored } = setup("editor", emptyModel("Main"));
    withLibrary(server);
    const { user } = renderApp("/dashboards/d-main");
    await user.click((await screen.findAllByRole("button", { name: "Edit" }))[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Add library panel" }));
    const dialog = screen.getByRole("dialog", { name: "Add library panel" });
    await user.click(await within(dialog).findByRole("radio", { name: /Revenue per day/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    const card = await screen.findByRole("article", { name: "Revenue" });
    expect(within(card).getByText("Library")).toBeTruthy();
    await saveDashboard(user);
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    const saved = latest(stored).model.panels[0];
    expect(saved).toEqual({
      id: expect.any(String),
      type: "table",
      title: "Revenue",
      grid: { x: 0, y: 0, w: 12, h: 8 },
      targets: [],
      transformations: [],
      options: {},
      fieldConfig: {},
      libraryPanelId: "lib-1",
    });
    // Viewing runs the library panel's queries through the panel route.
    await waitFor(() =>
      expect(server.areas.dashboards.panelQueries.some((q) => q.panelId === saved?.id)).toBe(true),
    );
  });

  it("warns how many dashboards change before a library panel is saved", async () => {
    const { server, stored } = setup("editor", {
      ...emptyModel("Main"),
      panels: [{ ...panel("lp", "Revenue"), targets: [], libraryPanelId: "lib-1" }],
    });
    withLibrary(server);
    addDashboard(server.areas.dashboards, "d-two", {
      ...emptyModel("Two"),
      panels: [{ ...panel("lp", "Revenue"), targets: [], libraryPanelId: "lib-1" }],
    });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(
      within(await screen.findByRole("article", { name: "Revenue" })).getByRole("button", {
        name: "Edit “Revenue”",
      }),
    );
    const editor = screen.getByRole("dialog", { name: "Edit panel" });
    expect(
      within(editor).getByText(/This panel shows the library panel “Revenue per day”/),
    ).toBeTruthy();
    await replace(
      user,
      within(editor).getByRole("textbox", { name: "Panel title" }),
      "Revenue net",
    );
    await user.click(within(editor).getByRole("button", { name: "Apply" }));
    const warning = await screen.findByRole("dialog", { name: "Change library panel?" });
    expect(
      await within(warning).findByText(
        "“Revenue per day” is shown by 2 dashboards. The change shows on all of them at once.",
      ),
    ).toBeTruthy();
    await user.click(within(warning).getByRole("button", { name: "Change everywhere" }));
    await waitFor(() => expect(server.areas.dashboardFeatures.libraryPanels[0]?.version).toBe(2));
    expect(server.areas.dashboardFeatures.libraryPanels[0]?.model).toMatchObject({
      title: "Revenue net",
    });
    expect(await screen.findByRole("article", { name: "Revenue net" })).toBeTruthy();
    // The dashboard itself only keeps the reference.
    expect(stored.versions).toHaveLength(1);
  });

  it("makes a library panel from a panel", async () => {
    const { server, stored } = setup("editor", {
      ...emptyModel("Main"),
      panels: [
        panel("p1", "Orders", {
          options: { unit: "EUR" },
          fieldConfig: { decimals: 2 },
          transformations: [{ type: "filter" }],
          links: [{ title: "More", url: "/dashboards" }],
        }),
      ],
    });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(article("Orders")).getByRole("button", { name: "Edit “Orders”" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Edit panel" })).getByRole("button", {
        name: "Make library panel…",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make library panel" });
    await user.click(within(dialog).getByRole("button", { name: "Make library panel" }));
    await waitFor(() => expect(server.areas.dashboardFeatures.libraryPanels).toHaveLength(1));
    expect(server.areas.dashboardFeatures.libraryPanels[0]?.model).not.toHaveProperty("grid");
    await saveDashboard(user);
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    expect(latest(stored).model.panels[0]).toEqual({
      id: "p1",
      type: "table",
      title: "Orders",
      grid: { x: 0, y: 0, w: 12, h: 8 },
      targets: [],
      transformations: [],
      options: {},
      fieldConfig: {},
      libraryPanelId: "lib-1",
    });
  });
});

describe("JSON, import and export", () => {
  it("asks before closing the JSON model with typed changes", async () => {
    setup("editor", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Settings…" }));
    await user.click(screen.getByRole("button", { name: "JSON model…" }));
    const dialog = screen.getByRole("dialog", { name: "JSON model" });
    // Unchanged, Escape just closes it.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "JSON model" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Settings…" }));
    await user.click(screen.getByRole("button", { name: "JSON model…" }));
    const again = screen.getByRole("dialog", { name: "JSON model" });
    await user.type(within(again).getByRole("textbox", { name: "Dashboard model" }), " ");
    await user.keyboard("{Escape}");
    const confirm = screen.getByRole("dialog", { name: "Discard JSON changes?" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "JSON model" })).toBeTruthy();
    await user.click(within(again).getByRole("button", { name: "Cancel" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Discard JSON changes?" })).getByRole("button", {
        name: "Discard",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "JSON model" })).toBeNull();
    expect(dialog.isConnected).toBe(false);
  });

  it("applies an edited JSON model after the server checked it", async () => {
    const { stored } = setup("editor", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Settings…" }));
    await user.click(screen.getByRole("button", { name: "JSON model…" }));
    const dialog = screen.getByRole("dialog", { name: "JSON model" });
    const text = within(dialog).getByRole("textbox", { name: "Dashboard model" });
    await replace(user, text, "{ not json");
    await user.click(within(dialog).getByRole("button", { name: "Check and apply" }));
    expect(await within(dialog).findByText(/This is not valid JSON/)).toBeTruthy();
    const next = { ...latest(stored).model, title: "Main renamed" };
    await replace(user, text, JSON.stringify({ ...next, bogus: 1 }));
    await user.click(within(dialog).getByRole("button", { name: "Check and apply" }));
    expect(await within(dialog).findByText(/model.bogus: unknown field/)).toBeTruthy();
    await replace(user, text, JSON.stringify(next));
    await user.click(within(dialog).getByRole("button", { name: "Check and apply" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Main renamed" })).toBeTruthy();
    await saveDashboard(user);
    await waitFor(() => expect(latest(stored).model.title).toBe("Main renamed"));
  });

  it("imports an export, mapping its data sources by kind and name after confirmation", async () => {
    const { server } = setup("editor", emptyModel("Main"));
    const exported = {
      kalzit: "dashboard",
      exportVersion: 1,
      model: {
        ...emptyModel("Imported"),
        panels: [
          {
            ...panel("p1", "Orders"),
            targets: [{ refId: "A", datasourceId: "elsewhere-1", query: { sql: "SELECT 1" } }],
          },
        ],
      },
      datasources: [{ id: "elsewhere-1", kind: "postgres", name: "Shop" }],
    };
    const shop = server.areas.datasources.datasources.find((d) => d.id === PG_ID);
    expect(shop).toBeDefined();
    const { user, location } = renderApp("/dashboards");
    await user.click(await screen.findByRole("button", { name: "Import…" }));
    const dialog = screen.getByRole("dialog", { name: "Import dashboard" });
    await fill(
      user,
      within(dialog).getByRole("textbox", { name: "Or paste the JSON" }),
      JSON.stringify({
        ...exported,
        datasources: [{ ...exported.datasources[0], name: shop?.name, kind: shop?.kind }],
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Check" }));
    const mapping = await within(dialog).findByRole("combobox", {
      name: new RegExp(shop?.name ?? ""),
    });
    expect((mapping as HTMLSelectElement).value).toBe(PG_ID);
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(location().pathname).toMatch(/^\/dashboards\/dash-new-/));
    const created = server.areas.dashboards.dashboards.at(-1) as StoredDashboard;
    expect(latest(created).model.panels[0]?.targets[0]?.datasourceId).toBe(PG_ID);
  });

  it("exports the dashboard with its data sources' kind and name", async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:export";
    });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    setup("editor", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByText("More"));
    await user.click(screen.getByRole("button", { name: "Export as JSON" }));
    await waitFor(() => expect(created).toHaveLength(1));
    const file = JSON.parse(await (created[0] as Blob).text());
    expect(file).toMatchObject({ kalzit: "dashboard", model: { title: "Main" } });
    expect(file.datasources[0]).toMatchObject({ id: PG_ID, kind: "postgres" });
  });
});

describe("copy and save as", () => {
  it("copies a panel into another dashboard as a new version there", async () => {
    const { server } = setup("editor", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
    const other = addDashboard(server.areas.dashboards, "d-other", {
      ...emptyModel("Other"),
      panels: [panel("x", "Old")],
    });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(
      within(article("Orders")).getByRole("button", { name: "Copy “Orders” to another dashboard" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Copy panel to another dashboard" });
    expect(within(dialog).queryByRole("radio", { name: "Main" })).toBeNull();
    await user.click(await within(dialog).findByRole("radio", { name: "Other" }));
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(await screen.findByText("The panel was copied to “Other”.")).toBeTruthy();
    const panels = latest(other).model.panels;
    expect(panels.map((p) => p.title)).toEqual(["Old", "Orders"]);
    expect(panels[1]?.id).not.toBe("p1");
    expect(panels[1]?.grid.y).toBe(8);
  });

  it("saves the dashboard as a new one and opens it", async () => {
    const { server } = setup("editor", { ...emptyModel("Main"), panels: [panel("p1", "Orders")] });
    const { user, location } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByText("More"));
    await user.click(screen.getByRole("button", { name: "Save as…" }));
    const dialog = screen.getByRole("dialog", { name: "Save as new dashboard" });
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveProperty(
      "value",
      "Main (copy)",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save as new dashboard" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/dash-new-1"));
    const created = server.areas.dashboards.dashboards.at(-1) as StoredDashboard;
    expect(created.folderId).toBe("f-ops");
    expect(latest(created).model.panels).toHaveLength(1);
  });
});
