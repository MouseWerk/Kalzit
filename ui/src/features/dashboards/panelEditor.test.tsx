import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { forgetAccountData } from "../../api/auth";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { MAX_KEPT_DRAFTS, readDraft, writeDraft } from "./draftStore";
import { EDITOR_LAYOUT_KEY, readEditorLayout } from "./editorLayout";
import { type DashboardModel, emptyModel, type PanelModel, placePanel } from "./model";
import { addDashboard, latest } from "./test/fakeDashboards";

/** Opens a panel's menu and picks an action, named as the old buttons were ("Edit “Orders”"). */
async function panelAction(user: ReturnType<typeof renderApp>["user"], name: string) {
  const title = /“(.*)”/.exec(name)?.[1] ?? "";
  const panel = await screen.findByRole("article", { name: title });
  await user.click(within(panel).getByRole("button", { name: `Panel menu of “${title}”` }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

/**
 * The full-page panel editor (docs/design/feel.md sections 5 and 10): its route, leaving it with
 * and without the change, the guard for unsaved changes, the remembered splits, and that typing
 * in one query draws that query's editor only.
 */

// Render counts per query editor and of the preview. The query editor is replaced by a plain
// text field (CodeMirror needs a layout jsdom does not have); the preview is the real one.
const renders = vi.hoisted(() => ({
  editors: new Map<string, number>(),
  preview: 0,
  bodies: new Map<string, number>(),
}));

vi.mock("../datasources/editors/QueryEditor", () => ({
  QueryEditor: (props: {
    label?: string;
    query: unknown;
    onChange: (query: unknown) => void;
    onRun?: () => void;
  }) => {
    const label = props.label ?? "Query";
    renders.editors.set(label, (renders.editors.get(label) ?? 0) + 1);
    const sql = (props.query as { sql?: string } | undefined)?.sql ?? "";
    return (
      <textarea
        aria-label={label}
        value={sql}
        onChange={(event) => props.onChange({ sql: event.currentTarget.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.ctrlKey) props.onRun?.();
        }}
      />
    );
  },
}));

vi.mock("./PanelCard", async (importOriginal) => {
  const real = await importOriginal<typeof import("./PanelCard")>();
  return {
    ...real,
    PanelBody: (props: ComponentProps<typeof real.PanelBody>) => {
      renders.preview += 1;
      return <real.PanelBody {...props} />;
    },
  };
});

// Each drawn visualization, by panel title: the card's body calls it through the registry.
vi.mock("../../panels/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../panels/registry")>();
  const wrapped = new Map<string, ReturnType<typeof real.getPanel>>();
  return {
    ...real,
    getPanel: (type: string) => {
      const plugin = real.getPanel(type);
      if (plugin === undefined) return plugin;
      let counted = wrapped.get(type);
      if (counted === undefined) {
        const Real = plugin.Panel;
        counted = {
          ...plugin,
          Panel: (props: ComponentProps<typeof Real>) => {
            renders.bodies.set(props.title, (renders.bodies.get(props.title) ?? 0) + 1);
            return <Real {...props} />;
          },
        } as typeof plugin;
        wrapped.set(type, counted);
      }
      return counted;
    },
  };
});

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function panel(id: string, title: string, extra: Partial<PanelModel> = {}): PanelModel {
  return {
    id,
    type: "table",
    title,
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM orders" } }],
    transformations: [],
    options: {},
    fieldConfig: {},
    ...extra,
  };
}

function setup(role = "editor", model?: DashboardModel) {
  const server = installFakeServer({ signedIn: true, user: asRole(role) });
  const stored = addDashboard(
    server.areas.dashboards,
    "d-main",
    model ?? { ...emptyModel("Main"), panels: [panel("p1", "Orders")] },
  );
  return { server, stored };
}

const crumb = (name: string) =>
  within(screen.getByRole("navigation", { name: "Breadcrumbs" })).getByRole("link", { name });

const editorRegion = () => screen.findByRole("region", { name: "Edit panel" });

async function openEditor(user: ReturnType<typeof renderApp>["user"], title: string) {
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  await panelAction(user, `Edit “${title}”`);
  return editorRegion();
}

describe("the panel editor page", () => {
  it("has its own address and goes back with Esc, keeping the change unsaved", async () => {
    const { stored } = setup();
    const { user, location } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    expect(location().pathname).toBe("/dashboards/d-main/panels/p1/edit");
    // A page of its own, not a dialog; the dashboard's grid is not drawn behind it.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("article", { name: "Orders" })).toBeNull();
    const title = within(editor).getByRole("textbox", { name: "Panel title" });
    await user.clear(title);
    await user.paste("Orders per day");
    await user.click(document.body);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main"));
    expect(await screen.findByRole("article", { name: "Orders per day" })).toBeTruthy();
    expect(screen.getByText(/^Edit mode, unsaved changes/)).toBeTruthy();
    expect(stored.versions).toHaveLength(1);
  });

  it("puts the panel back as it was on Discard, and leaves no trace of a new one", async () => {
    setup();
    const { user, location } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    const title = within(editor).getByRole("textbox", { name: "Panel title" });
    await user.clear(title);
    await user.paste("Renamed");
    await user.click(within(editor).getByRole("button", { name: "Discard" }));
    const confirm = screen.getByRole("dialog", { name: "Discard the changes to this panel?" });
    await user.click(within(confirm).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main"));
    expect(await screen.findByRole("article", { name: "Orders" })).toBeTruthy();
    expect(screen.getByText(/^Edit mode\. /)).toBeTruthy();

    await user.click(
      within(screen.getByRole("complementary", { name: "Dashboard tools" })).getByRole("button", {
        name: "Add",
      }),
    );
    await user.click(screen.getByRole("button", { name: "All" }));
    const added = await screen.findByRole("region", { name: "New panel" });
    expect(location().pathname).toBe("/dashboards/d-main/panels/new");
    await user.click(within(added).getByRole("button", { name: "Discard" }));
    const drop = screen.getByRole("dialog", { name: "Discard the changes to this panel?" });
    expect(within(drop).getByText("The new panel is not added to the dashboard.")).toBeTruthy();
    await user.click(within(drop).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main"));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText(/^Edit mode\. /)).toBeTruthy();
  });

  it("opens from its address in edit mode, and sends viewers back to the dashboard", async () => {
    setup();
    const first = renderApp("/dashboards/d-main/panels/p1/edit");
    const editor = await editorRegion();
    expect(within(editor).getByRole("textbox", { name: "Panel title" })).toHaveProperty(
      "value",
      "Orders",
    );
    first.view.unmount();

    setup("viewer");
    const { location } = renderApp("/dashboards/d-main/panels/p1/edit");
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main"));
    expect(await screen.findByRole("article", { name: "Orders" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Edit panel" })).toBeNull();
  });

  it("says so when the panel is not on the dashboard", async () => {
    setup();
    const { user, location } = renderApp("/dashboards/d-main/panels/gone/edit");
    expect(await screen.findByText("This panel is not on the dashboard")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main"));
  });

  it("asks before leaving the dashboard with unsaved changes, from the editor too", async () => {
    setup();
    const { user, location } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    const title = within(editor).getByRole("textbox", { name: "Panel title" });
    await user.clear(title);
    await user.paste("Changed");
    // The breadcrumb to the list leaves the dashboard.
    await user.click(crumb("Dashboards"));
    const ask = await screen.findByRole("dialog", { name: "Leave without saving?" });
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(location().pathname).toBe("/dashboards/d-main/panels/p1/edit");
    expect(within(editor).getByRole("textbox", { name: "Panel title" })).toHaveProperty(
      "value",
      "Changed",
    );
    await user.click(crumb("Dashboards"));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Leave without saving?" })).getByRole(
        "button",
        { name: "Leave" },
      ),
    );
    await waitFor(() => expect(location().pathname).toBe("/dashboards"));
  });

  it("saves the dashboard from the editor and stays in it", async () => {
    const { stored } = setup();
    const { user, location } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    const title = within(editor).getByRole("textbox", { name: "Panel title" });
    await user.clear(title);
    await user.paste("Saved title");
    await user.click(within(editor).getByRole("button", { name: "Save dashboard…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    expect(latest(stored).model.panels[0]?.title).toBe("Saved title");
    expect(location().pathname).toBe("/dashboards/d-main/panels/p1/edit");
    const again = await editorRegion();
    expect(within(again).getByRole("textbox", { name: "Panel title" })).toHaveProperty(
      "value",
      "Saved title",
    );
  });

  it("shows queries and steps as tabs with their counts", async () => {
    setup("editor", {
      ...emptyModel("Main"),
      panels: [
        panel("p1", "Orders", {
          targets: [
            { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT 1" } },
            { refId: "B", datasourceId: PG_ID, query: { sql: "SELECT 2" } },
          ],
        }),
      ],
    });
    const { user } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    const queries = within(editor).getByRole("tab", { name: "Queries 2" });
    const steps = within(editor).getByRole("tab", { name: "Steps 0" });
    expect(queries.getAttribute("aria-selected")).toBe("true");
    queries.focus();
    await user.keyboard("{ArrowRight}");
    expect(steps.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(steps);
    // The queries stay mounted behind their tab, so switching back keeps them as they were.
    expect(within(editor).getByLabelText("Query A", { selector: "textarea" })).toBeTruthy();
  });

  it("moves the splits with the keyboard and remembers them per account", async () => {
    setup();
    const { user } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    const options = within(editor).getByRole("separator", { name: "Width of the options" });
    expect(options.getAttribute("aria-valuenow")).toBe("330");
    options.focus();
    // The pane is on the right: the separator moving left makes it wider.
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(options.getAttribute("aria-valuenow")).toBe("362");
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(options.getAttribute("aria-valuenow")).toBe("298");
    await user.keyboard("{End}");
    expect(options.getAttribute("aria-valuenow")).toBe("640");
    expect(readEditorLayout("u1").options).toBe(640);
    expect(readEditorLayout("someone else")).toEqual({});

    const preview = within(editor).getByRole("separator", { name: "Height of the preview" });
    preview.focus();
    await user.keyboard("{Home}");
    expect(preview.getAttribute("aria-valuenow")).toBe("160");
    await user.click(within(editor).getByRole("button", { name: "Hide options" }));
    expect(readEditorLayout("u1")).toEqual({ options: 640, preview: 160, collapsed: true });
    expect(within(editor).queryByRole("separator", { name: "Width of the options" })).toBeNull();
    expect(within(editor).getByRole("button", { name: "Show options" })).toBeTruthy();
  });

  it("ignores a layout in the storage that is not its own shape", () => {
    window.localStorage.setItem(
      EDITOR_LAYOUT_KEY,
      JSON.stringify({ u1: { options: "wide", preview: -3, collapsed: "yes" } }),
    );
    expect(readEditorLayout("u1")).toEqual({});
    window.localStorage.setItem(EDITOR_LAYOUT_KEY, "{not json");
    expect(readEditorLayout("u1")).toEqual({});
  });

  it("draws only the query being typed in, and runs it on Ctrl+Enter or when focus leaves", async () => {
    const { server } = setup("editor", {
      ...emptyModel("Main"),
      panels: [
        panel("p1", "Orders", {
          targets: [
            { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT 1" } },
            { refId: "B", datasourceId: PG_ID, query: { sql: "SELECT 2" } },
          ],
        }),
      ],
    });
    const { user } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    const a = within(editor).getByLabelText("Query A", { selector: "textarea" });
    await waitFor(() => expect(renders.editors.get("Query A")).toBeGreaterThan(0));
    // Let the first run settle, then count from here.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = {
      a: renders.editors.get("Query A") ?? 0,
      b: renders.editors.get("Query B") ?? 0,
      preview: renders.preview,
      queries: server.areas.datasources.queries.length,
    };
    a.focus();
    await user.keyboard(" WHERE");
    expect((renders.editors.get("Query A") ?? 0) - before.a).toBe(6);
    expect(renders.editors.get("Query B")).toBe(before.b);
    expect(renders.preview).toBe(before.preview);
    // No query per key.
    expect(server.areas.datasources.queries.length).toBe(before.queries);

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(server.areas.datasources.queries.length).toBeGreaterThan(before.queries),
    );
    const afterRun = server.areas.datasources.queries.length;
    await user.keyboard(" 1");
    fireEvent.blur(a, {
      relatedTarget: within(editor).getByRole("textbox", { name: "Panel title" }),
    });
    await waitFor(() => expect(server.areas.datasources.queries.length).toBeGreaterThan(afterRun));
  });
});

describe("adding and leaving panels", () => {
  it("adds a panel on its own page and to the dashboard only on Apply", async () => {
    const { stored } = setup();
    const { user, location } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(
      within(screen.getByRole("complementary", { name: "Dashboard tools" })).getByRole("button", {
        name: "Add",
      }),
    );
    await user.click(screen.getByRole("button", { name: "All" }));
    const editor = await screen.findByRole("region", { name: "New panel" });
    expect(location().pathname).toBe("/dashboards/d-main/panels/new");
    // The visualization comes first, open; a first query is ready on the first source.
    expect(
      within(editor).getByRole("button", { name: "Visualization" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(await within(editor).findByLabelText("Query A", { selector: "textarea" })).toBeTruthy();
    // The time range and refresh of the dashboard are in the editor's bar.
    expect(within(editor).getByRole("button", { name: "Refresh" })).toBeTruthy();
    await user.type(within(editor).getByRole("textbox", { name: "Panel title" }), "Fresh");
    await user.click(within(editor).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main"));
    expect(await screen.findByRole("article", { name: "Fresh" })).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(stored.versions).toHaveLength(1);
  });

  it("folds the visualization of a panel that has one, and shows the preview as a table", async () => {
    setup("editor", {
      ...emptyModel("Main"),
      panels: [panel("p1", "Orders", { type: "timeseries" })],
    });
    const { user } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    const viz = within(editor).getByRole("button", { name: "Visualization Time series" });
    expect(viz.getAttribute("aria-expanded")).toBe("false");
    expect(viz.textContent).toContain("Time series");
    const table = within(editor).getByRole("button", { name: "Table view" });
    expect(table.getAttribute("aria-pressed")).toBe("false");
    await user.click(table);
    expect(table.getAttribute("aria-pressed")).toBe("true");
  });

  it("treats leaving by a link (as the browser's back button) as Discard, after asking", async () => {
    setup();
    const { user, location } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    const title = within(editor).getByRole("textbox", { name: "Panel title" });
    await user.clear(title);
    await user.paste("Not kept");
    // The dashboard's crumb, like the browser's back button, does not take the change along.
    await user.click(crumb("Main"));
    const ask = await screen.findByRole("dialog", { name: "Discard the changes to this panel?" });
    await user.click(within(ask).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main"));
    expect(await screen.findByRole("article", { name: "Orders" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Not kept" })).toBeNull();
  });

  it("keeps the draft and the editor's panel across a reload of the tab", async () => {
    setup();
    const first = renderApp("/dashboards/d-main");
    const editor = await openEditor(first.user, "Orders");
    const title = within(editor).getByRole("textbox", { name: "Panel title" });
    await first.user.clear(title);
    await first.user.paste("Still here");
    // Kept a moment after the last change.
    await waitFor(() =>
      expect(window.sessionStorage.getItem("kalzit.draft.u1.o1.d-main")).toContain("Still here"),
    );
    first.view.unmount();
    renderApp("/dashboards/d-main/panels/p1/edit");
    const again = await editorRegion();
    expect(within(again).getByRole("textbox", { name: "Panel title" })).toHaveProperty(
      "value",
      "Still here",
    );
  });

  it("duplicates, hides and folds queries; a hidden query is stored but does not run", async () => {
    const { server, stored } = setup();
    const { user } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    await user.click(within(editor).getByRole("button", { name: "Duplicate query A" }));
    expect(await within(editor).findByLabelText("Query B", { selector: "textarea" })).toBeTruthy();
    const hide = within(editor).getByRole("button", { name: "Hide query B" });
    await user.click(hide);
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    expect(within(editor).getByText("Hidden")).toBeTruthy();
    const fold = within(editor).getByRole("button", { name: "Fold query A" });
    await user.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    const before = server.areas.datasources.queries.length;
    await user.click(within(editor).getByRole("button", { name: "Run queries" }));
    await waitFor(() => expect(server.areas.datasources.queries.length).toBeGreaterThan(before));
    const sent = server.areas.datasources.queries.at(-1) as { queries: { refId: string }[] };
    expect(sent.queries.map((q) => q.refId)).toEqual(["A"]);
    await user.click(within(editor).getByRole("button", { name: "Save dashboard…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    expect(latest(stored).model.panels[0]?.targets).toMatchObject([
      { refId: "A" },
      { refId: "B", hide: true },
    ]);
  });
});

describe("drafts kept in the tab", () => {
  /** User u1 left an unsaved draft of d-main in this tab, renamed and with the editor open. */
  function leftBehind() {
    const model = { ...emptyModel("Main"), panels: [panel("p1", "Orders from u1")] };
    window.sessionStorage.setItem(
      "kalzit.draft.u1.o1.d-main",
      JSON.stringify({ userId: "u1", orgId: "o1", at: 1, version: 1, model }),
    );
  }

  it("never shows one account's draft to another in the same tab", async () => {
    leftBehind();
    const server = installFakeServer({
      signedIn: true,
      user: { ...asRole("editor"), id: "u2", email: "b@example.com", name: "Bea" },
    });
    addDashboard(server.areas.dashboards, "d-main", {
      ...emptyModel("Main"),
      panels: [panel("p1", "Orders")],
    });
    renderApp("/dashboards/d-main");
    expect(await screen.findByRole("article", { name: "Orders" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Orders from u1" })).toBeNull();
    expect(screen.queryByText(/^Edit mode/)).toBeNull();
  });

  it("drops a kept draft for someone who may no longer edit", async () => {
    leftBehind();
    setup("viewer");
    renderApp("/dashboards/d-main");
    expect(await screen.findByRole("article", { name: "Orders" })).toBeTruthy();
    expect(screen.queryByText(/^Edit mode/)).toBeNull();
    await waitFor(() =>
      expect(window.sessionStorage.getItem("kalzit.draft.u1.o1.d-main")).toBeNull(),
    );
  });

  it("brings a kept draft back for its own editor, and forgets every draft on sign-out", async () => {
    leftBehind();
    setup();
    renderApp("/dashboards/d-main");
    expect(await screen.findByRole("article", { name: "Orders from u1" })).toBeTruthy();
    expect(screen.getByText(/^Edit mode, unsaved changes/)).toBeTruthy();
    forgetAccountData(new QueryClient());
    expect(window.sessionStorage.getItem("kalzit.draft.u1.o1.d-main")).toBeNull();
  });

  it("keeps only the latest few drafts", () => {
    const owner = { userId: "u1", orgId: "o1" };
    for (let i = 0; i < MAX_KEPT_DRAFTS + 2; i++) {
      writeDraft(owner, `d-${i}`, { version: 1, model: emptyModel(`D${i}`) });
    }
    const kept = Object.keys(window.sessionStorage).filter((k) => k.startsWith("kalzit.draft."));
    expect(kept).toHaveLength(MAX_KEPT_DRAFTS);
    expect(readDraft(owner, `d-${MAX_KEPT_DRAFTS + 1}`, 1)).not.toBeNull();
  });
});

describe("focus around the editor", () => {
  it("starts on the editor's heading and comes back to the panel's menu", async () => {
    setup();
    const { user } = renderApp("/dashboards/d-main");
    const editor = await openEditor(user, "Orders");
    await waitFor(() =>
      expect(document.activeElement).toBe(within(editor).getByRole("heading", { level: 1 })),
    );
    await user.keyboard("{Escape}");
    const menu = await screen.findByRole("button", { name: "Panel menu of “Orders”" });
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });

  it("returns focus from the panel menu to its button on Tab", async () => {
    setup();
    const { user } = renderApp("/dashboards/d-main");
    const button = await screen.findByRole("button", { name: "Panel menu of “Orders”" });
    await user.click(button);
    expect(await screen.findByRole("menu")).toBeTruthy();
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe("placing a panel", () => {
  it("draws again only the panel that moved", async () => {
    setup("editor", {
      ...emptyModel("Main"),
      panels: [
        panel("p1", "Left", { grid: { x: 0, y: 0, w: 12, h: 8 } }),
        panel("p2", "Right", { grid: { x: 12, y: 0, w: 12, h: 8 } }),
        panel("p3", "Below", { grid: { x: 0, y: 8, w: 12, h: 8 } }),
      ],
    });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const below = await screen.findByRole("article", { name: "Below" });
    await waitFor(() => expect(within(below).getAllByText("Grace").length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = new Map(renders.bodies);
    within(below).getByRole("button", { name: "Arrange “Below”" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(renders.bodies.get("Below")).toBeGreaterThan(before.get("Below") ?? 0);
    expect(renders.bodies.get("Left")).toBe(before.get("Left"));
    expect(renders.bodies.get("Right")).toBe(before.get("Right"));
  });

  it("keeps every panel that does not move as the same object", () => {
    const a = panel("a", "A", { grid: { x: 0, y: 0, w: 12, h: 4 } });
    const b = panel("b", "B", { grid: { x: 12, y: 0, w: 12, h: 4 } });
    const c = panel("c", "C", { grid: { x: 0, y: 4, w: 12, h: 4 } });
    const placed = placePanel([a, b, c], "a", { x: 0, y: 2, w: 12, h: 4 });
    // The moved panel and the one it pushed down are new; the one beside them is untouched.
    expect(placed[0]).not.toBe(a);
    expect(placed[1]).toBe(b);
    expect(placed[2]).not.toBe(c);
    expect(placed[2]?.grid.y).toBe(6);
    // Placing a panel where it already is changes nothing.
    const same = placePanel([a, b, c], "b", b.grid);
    expect(same.every((p, i) => p === [a, b, c][i])).toBe(true);
  });
});
