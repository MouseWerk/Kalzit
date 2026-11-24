import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PublicDashboard } from "../../api/generated/shapes";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { pickOption } from "../../test/select";
import { hasQuery } from "../datasources/queryKinds";
import { PG_ID, PROM_ID } from "../datasources/test/fakeDatasources";
import { FixedValues } from "../sharing/SharedBoard";
import { decodeFilter, decodeFilters, encodeFilter, operatorsFor, storedFilters } from "./adhoc";
import { dependencies, findCycles, levelsOf } from "./dependencies";
import { fitAddressValues } from "./links";
import {
  cleanVariable,
  type DashboardModel,
  emptyModel,
  filtersFor,
  type PanelModel,
  parseModel,
  storedQueryVariables,
  targetSource,
  type VariableModel,
} from "./model";
import { helperText } from "./PrometheusHelpers";
import { filtersNotApplied } from "./results";
import { addDashboard, addFolder, latest } from "./test/fakeDashboards";
import { initialVariables, withDefaults } from "./Variables";

/**
 * The variable kinds of board ParityEditors, frames 10 and 11: data source variables, ad hoc
 * filters ("Freie Filter") and switches in the bar and in the editor, and the dependencies tab.
 */

const level = { key: "level", operator: "=", value: "error" } as const;
const host = { key: "host", operator: "!=", value: "web-1" } as const;

function panel(id: string, title: string, extra: Partial<PanelModel> = {}): PanelModel {
  return {
    id,
    type: "table",
    title,
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT 1 WHERE $__filter" } }],
    transformations: [],
    options: {},
    fieldConfig: {},
    ...extra,
  };
}

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function setup(role: string, model: DashboardModel) {
  const server = installFakeServer({ signedIn: true, user: asRole(role) });
  addFolder(server.areas.dashboards, "f-ops", "Operations");
  const stored = addDashboard(server.areas.dashboards, "d-main", model, { folderId: "f-ops" });
  return { server, stored };
}

describe("ad hoc filter values", () => {
  it("keeps a filter as text and reads it back, refusing anything else", () => {
    const text = encodeFilter({ key: 'a"b', operator: "=~", value: "x|y" });
    expect(decodeFilter(text)).toEqual({ key: 'a"b', operator: "=~", value: "x|y" });
    expect(decodeFilter("level=error")).toBeNull();
    expect(decodeFilter(JSON.stringify(["k", "<>", "v"]))).toBeNull();
    expect(decodeFilters([text, "junk"])).toHaveLength(1);
  });

  it("reads stored filters, dropping malformed ones", () => {
    expect(
      storedFilters([level, { key: "n", operator: ">", value: 5 }, { key: "x" }, "bad"]),
    ).toEqual([level, { key: "n", operator: ">", value: "5" }]);
    expect(storedFilters(undefined)).toEqual([]);
  });

  it("offers the operators the source's kind can apply", () => {
    expect(operatorsFor("prometheus")).toEqual(["=", "!=", "=~", "!~"]);
    expect(operatorsFor("postgres")).toEqual(["=", "!=", "<", ">"]);
    expect(operatorsFor("elasticsearch")).toHaveLength(6);
    expect(operatorsFor("mongodb")).toEqual([]);
  });

  it("sends filters as objects on the stored routes and leaves constants out", () => {
    const saved: VariableModel[] = [
      { name: "filters", type: "adhoc", datasourceId: PG_ID },
      { name: "c", type: "constant", current: "x" },
      { name: "flag", type: "switch", onValue: "1", offValue: "0" },
    ];
    expect(
      storedQueryVariables({ filters: [encodeFilter(level)], c: "x", flag: "1", gone: "y" }, saved),
    ).toEqual({ filters: [level], flag: "1" });
  });

  it("resolves a $name target and its filters for the free route", () => {
    const variables: VariableModel[] = [
      { name: "src", type: "datasource", datasourceKind: "postgres", current: PG_ID },
      { name: "filters", type: "adhoc", datasourceId: PG_ID, current: [level] },
    ];
    expect(targetSource("$src", {}, variables)).toBe(PG_ID);
    expect(targetSource("$src", { src: "ds-other" }, variables)).toBe("ds-other");
    expect(targetSource(PROM_ID, {}, variables)).toBe(PROM_ID);
    expect(filtersFor(PG_ID, {}, variables)).toEqual([level]);
    expect(filtersFor(PG_ID, { filters: [encodeFilter(host)] }, variables)).toEqual([host]);
    expect(filtersFor(PROM_ID, {}, variables)).toEqual([]);
  });
});

describe("the new kinds in the model", () => {
  it("parses the kinds and their fields instead of turning them into free text", () => {
    const model = parseModel(
      {
        variables: [
          { name: "src", type: "datasource", datasourceKind: "postgres", current: PG_ID },
          { name: "f", type: "adhoc", datasourceId: PG_ID, current: [level] },
          { name: "on", type: "switch", onValue: "yes", offValue: "no", current: "no" },
        ],
      },
      "T",
    );
    expect(model.variables.map((v) => v.type)).toEqual(["datasource", "adhoc", "switch"]);
    expect(model.variables[0]?.datasourceKind).toBe("postgres");
    expect(model.variables[2]?.onValue).toBe("yes");
  });

  it("drops fields of another kind before a save", () => {
    expect(
      cleanVariable({
        name: "x",
        type: "custom",
        options: ["a"],
        onValue: "1",
        offValue: "0",
        datasourceKind: "postgres",
      }),
    ).toEqual({ name: "x", type: "custom", options: ["a"] });
    expect(cleanVariable({ name: "f", type: "adhoc", datasourceId: PG_ID, current: [] })).toEqual({
      name: "f",
      type: "adhoc",
      datasourceId: PG_ID,
    });
    expect(
      cleanVariable({
        name: "s",
        type: "datasource",
        datasourceKind: "postgres",
        regex: "/^Shop/",
        current: PG_ID,
      }).regex,
    ).toBe("/^Shop/");
  });

  it("opens with the stored filters and switch value, and saves the ones on screen", () => {
    const variables: VariableModel[] = [
      { name: "f", type: "adhoc", datasourceId: PG_ID, current: [level] },
      { name: "on", type: "switch", onValue: "yes", offValue: "no" },
    ];
    const start = initialVariables(variables);
    expect(start).toEqual({ f: [encodeFilter(level)], on: "no" });
    const saved = withDefaults(
      { ...emptyModel("T"), variables },
      { values: { f: [encodeFilter(host)], on: "yes" } },
    );
    expect(saved.variables[0]?.current).toEqual([host]);
    expect(saved.variables[1]?.current).toBe("yes");
  });

  it("takes only filters the server accepts from an address, 20 at most over all", () => {
    const variables: VariableModel[] = [
      { name: "a", type: "adhoc", datasourceId: PG_ID },
      { name: "b", type: "adhoc", datasourceId: PROM_ID },
    ];
    const ok = (n: number) => encodeFilter({ key: `k${n}`, operator: "=", value: "v" });
    const fitted = fitAddressValues(variables, {
      a: [
        encodeFilter({ key: "  ", operator: "=", value: "v" }),
        encodeFilter({ key: "x".repeat(201), operator: "=", value: "v" }),
        encodeFilter({ key: "a\u0007b", operator: "=", value: "v" }),
        encodeFilter({ key: "k", operator: "=", value: "v".repeat(1001) }),
        encodeFilter({ key: "k", operator: "=", value: "a\u0000" }),
        ...Array.from({ length: 15 }, (_, i) => ok(i)),
      ],
      b: Array.from({ length: 10 }, (_, i) => ok(100 + i)),
    });
    expect(fitted.a).toHaveLength(15);
    expect(fitted.b).toHaveLength(5);
  });

  it("takes filters, switch values and sources from an address", () => {
    const variables: VariableModel[] = [
      { name: "f", type: "adhoc", datasourceId: PG_ID },
      { name: "on", type: "switch", onValue: "yes", offValue: "no" },
      { name: "src", type: "datasource", datasourceKind: "postgres", current: PG_ID },
    ];
    expect(
      fitAddressValues(variables, {
        f: [encodeFilter(level), "broken"],
        on: "maybe",
        src: "ds-other",
      }),
    ).toEqual({ f: [encodeFilter(level)], src: "ds-other" });
  });

  it("finds the notice that the filters did not apply", () => {
    const notice = {
      severity: "info" as const,
      code: "query.filters_not_applied",
      text: "not applied",
    };
    expect(
      filtersNotApplied([
        {
          refId: "A",
          result: {
            shape: "frame",
            frame: { fields: [], meta: { rowsTruncated: false, notices: [notice] } },
          },
        },
      ]),
    ).toBe(true);
    expect(filtersNotApplied([])).toBe(false);
  });
});

describe("dependencies", () => {
  const model: DashboardModel = {
    ...emptyModel("Main"),
    variables: [
      {
        name: "region",
        type: "query",
        datasourceId: PG_ID,
        query: { sql: "SELECT region FROM r WHERE host = $host" },
      },
      {
        name: "host",
        type: "query",
        datasourceId: PG_ID,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable as dashboards write it
        query: { sql: "SELECT host FROM h WHERE region = ${region}" },
      },
      { name: "old", type: "custom", options: ["a"] },
      { name: "env", type: "custom", options: ["prod"] },
    ],
    panels: [
      panel("p1", "CPU per host", {
        targets: [
          { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT $host, $__timeFilter(ts)" } },
        ],
      }),
      panel("p2", "Targets", {
        targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT $job" } }],
      }),
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable as links write it
    links: [{ type: "url", title: "Docs", url: "https://example.com/${env}" }],
  };

  it("says who needs whom, where each is used, and what is unused or unknown", () => {
    const report = dependencies(model);
    const of = (name: string) => report.variables.find((d) => d.variable.name === name);
    expect(of("region")?.dependsOn).toEqual(["host"]);
    expect(of("host")?.usedBy.map((u) => u.kind)).toEqual(["variable", "panel"]);
    expect(of("env")?.usedBy).toEqual([{ kind: "link", name: "Docs", id: "0" }]);
    expect(of("old")?.usedBy).toEqual([]);
    expect(report.unknown).toEqual([
      { name: "job", usedBy: [{ kind: "panel", name: "Targets", id: "p2" }] },
    ]);
    expect(report.cycles).toEqual([["region", "host"]]);
    expect(report.panelsUsing).toBe(2);
  });

  it("counts ad hoc filters as used where they reach a target, and never offers to remove them", () => {
    const report = dependencies({
      ...emptyModel("Main"),
      variables: [
        { name: "src", type: "datasource", datasourceKind: "prometheus", current: PROM_ID },
        { name: "pgFilters", type: "adhoc", datasourceId: PG_ID },
        { name: "anyFilters", type: "adhoc", datasourceId: "ds-elsewhere" },
        { name: "idle", type: "adhoc", datasourceId: "ds-unused" },
      ],
      panels: [
        panel("p1", "Orders"),
        panel("p2", "Up", {
          targets: [{ refId: "A", datasourceId: "$src", query: { expr: "up" } }],
        }),
      ],
      annotations: [
        {
          id: "a1",
          name: "Deploys",
          datasourceId: PG_ID,
          query: { sql: "SELECT 1" },
          enabled: true,
        },
      ],
    });
    const of = (name: string) => report.variables.find((d) => d.variable.name === name);
    expect(of("pgFilters")?.usedBy.map((u) => u.id)).toEqual(["p1", "p2", "a1"]);
    // A data source variable of a kind that filters may pick any source: its filters may apply.
    expect(of("anyFilters")?.usedBy.map((u) => u.id)).toEqual(["p2"]);
    expect(of("src")?.usedBy.map((u) => u.id)).toEqual(["p2"]);
    // Without a target on its source or a filtering data source variable, filters reach nothing.
    const alone = dependencies({
      ...emptyModel("Main"),
      variables: [{ name: "idle", type: "adhoc", datasourceId: "ds-unused" }],
      panels: [panel("p1", "Orders")],
    });
    expect(alone.variables[0]?.usedBy).toEqual([]);
  });

  it("orders variables by what they need, also with a cycle", () => {
    const graph = new Map([
      ["a", []],
      ["b", ["a"]],
      ["c", ["b", "a"]],
    ]);
    expect(levelsOf(graph)).toEqual({ a: 0, b: 1, c: 2 });
    expect(findCycles(graph)).toEqual([]);
    const loop = new Map([
      ["x", ["y"]],
      ["y", ["x"]],
    ]);
    expect(findCycles(loop)).toEqual([["x", "y"]]);
    expect(Object.keys(levelsOf(loop)).sort()).toEqual(["x", "y"]);
  });
});

describe("the bar", () => {
  const filterBoard = (extra: Partial<VariableModel> = {}): DashboardModel => ({
    ...emptyModel("Main"),
    variables: [
      { name: "filters", label: "Filters", type: "adhoc", datasourceId: PG_ID, ...extra },
    ],
    panels: [panel("p1", "Orders")],
  });
  const sentFilters = (server: ReturnType<typeof setup>["server"]) =>
    server.areas.dashboards.panelQueries.at(-1)?.body.variables?.filters;

  it("adds, changes and removes ad hoc filters, and the panel runs with them", async () => {
    const { server } = setup("viewer", filterBoard());
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Add filter" }));
    const editor = screen.getByRole("dialog", { name: "Add filter: Filters" });
    // The field has the focus first; Enter in the value applies.
    expect(document.activeElement).toBe(within(editor).getByLabelText("Field"));
    await user.keyboard("region");
    // SQL compares without patterns.
    const comparison = within(editor).getByRole("combobox", { name: "Comparison" });
    await pickOption(user, comparison, "!=");
    await user.click(within(editor).getByLabelText("Value"));
    await user.keyboard("Ost{Enter}");
    await waitFor(() =>
      expect(sentFilters(server)).toEqual([{ key: "region", operator: "!=", value: "Ost" }]),
    );

    // A click on the value changes only it.
    await user.click(
      screen.getByRole("button", { name: "Change value: region does not equal Ost" }),
    );
    const change = screen.getByRole("dialog", { name: "Change filter: Filters" });
    const value = within(change).getByLabelText("Value");
    expect(document.activeElement).toBe(value);
    await user.clear(value);
    await user.keyboard("West");
    await user.click(within(change).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(sentFilters(server)).toEqual([{ key: "region", operator: "!=", value: "West" }]),
    );

    await user.click(
      screen.getByRole("button", { name: "Remove filter: region does not equal West" }),
    );
    await waitFor(() => expect(sentFilters(server)).toEqual([]));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add filter" }));
  });

  it("refuses a filter without a field and closes on Escape without a change", async () => {
    const { server } = setup("viewer", filterBoard({ current: [level] }));
    const { user } = renderApp("/dashboards/d-main");
    await waitFor(() => expect(sentFilters(server)).toEqual([level]));
    await user.click(await screen.findByRole("button", { name: "Add filter" }));
    const editor = screen.getByRole("dialog", { name: "Add filter: Filters" });
    await user.click(within(editor).getByRole("button", { name: "Apply" }));
    const field = within(editor).getByLabelText("Field");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(within(editor).getByText("Enter the field to filter by.")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add filter: Filters" })).toBeNull();
    expect(sentFilters(server)).toEqual([level]);
  });

  it("offers label matchers for a Prometheus source", async () => {
    // An editor sees the source's kind; for a viewer the server alone decides.
    setup("editor", {
      ...filterBoard({ datasourceId: PROM_ID }),
      panels: [
        panel("p1", "Up", {
          targets: [{ refId: "A", datasourceId: PROM_ID, query: { expr: "up" } }],
        }),
      ],
    });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Add filter" }));
    const comparison = screen.getByRole("combobox", { name: "Comparison" });
    await user.click(comparison);
    const offered = screen.getAllByRole("option").map((o) => o.textContent?.trim() ?? "");
    expect(offered.some((text) => text.startsWith("<"))).toBe(false);
    expect(offered.some((text) => text.startsWith("=~"))).toBe(true);
  });

  it("switches between the switch's two values", async () => {
    const { server } = setup("viewer", {
      ...emptyModel("Main"),
      variables: [
        { name: "errors", label: "Only errors", type: "switch", onValue: "1", offValue: "0" },
      ],
      panels: [panel("p1", "Orders")],
    });
    const { user } = renderApp("/dashboards/d-main");
    const toggle = await screen.findByRole("switch", { name: "Only errors" });
    await waitFor(() =>
      expect(server.areas.dashboards.panelQueries.at(-1)?.body.variables?.errors).toBe("0"),
    );
    await user.click(toggle);
    await waitFor(() =>
      expect(server.areas.dashboards.panelQueries.at(-1)?.body.variables?.errors).toBe("1"),
    );
  });

  it("lists only the sources the server offers for a data source variable", async () => {
    const { server } = setup("viewer", {
      ...emptyModel("Main"),
      variables: [
        {
          name: "src",
          label: "Source",
          type: "datasource",
          datasourceKind: "postgres",
          current: PG_ID,
        },
      ],
      panels: [
        panel("p1", "Orders", {
          targets: [{ refId: "A", datasourceId: "$src", query: { sql: "SELECT 1" } }],
        }),
      ],
    });
    server.areas.dashboards.variableOptions.src = [
      { value: PG_ID, label: "Sales DB" },
      { value: "ds-staging", label: "Sales staging" },
    ];
    const { user } = renderApp("/dashboards/d-main");
    const select = await screen.findByRole("combobox", { name: "Source" });
    await pickOption(user, select, "Sales staging");
    await waitFor(() =>
      expect(server.areas.dashboards.panelQueries.at(-1)?.body.variables?.src).toBe("ds-staging"),
    );
  });

  it("says on a panel when the filters did not narrow it", async () => {
    const { server } = setup("viewer", filterBoard({ current: [level] }));
    server.areas.datasources.respond = () => ({
      result: {
        shape: "frame",
        frame: {
          fields: [{ name: "n", type: "number", values: [1] }],
          meta: {
            rowsTruncated: false,
            notices: [{ severity: "info", code: "query.filters_not_applied", text: "not applied" }],
          },
        },
      },
    });
    renderApp("/dashboards/d-main");
    const card = await screen.findByRole("article", { name: "Orders" });
    expect(await within(card).findByText("Ad hoc filters do not apply here")).toBeTruthy();
  });
});

describe("the editor", () => {
  it("makes a switch with two values and saves it", async () => {
    const { stored } = setup("editor", {
      ...emptyModel("Main"),
      variables: [{ name: "flag", type: "custom", options: ["a"] }],
      panels: [panel("p1", "Orders")],
    });
    const { user } = renderApp("/dashboards/d-main/settings?section=variables");
    const editor = await screen.findByRole("region", { name: "flag" });
    await pickOption(user, within(editor).getByRole("combobox", { name: "Kind" }), "Switch");
    const on = within(editor).getByLabelText("Value when on");
    expect(on).toHaveProperty("value", "true");
    await user.clear(on);
    await user.paste("yes");
    await user.click(within(editor).getByRole("switch", { name: "On when opening" }));
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() =>
      expect(latest(stored).model.variables[0]).toMatchObject({
        name: "flag",
        type: "switch",
        onValue: "yes",
        offValue: "false",
        current: "yes",
      }),
    );
  });

  it("asks for the source of ad hoc filters before saving", async () => {
    setup("editor", {
      ...emptyModel("Main"),
      variables: [{ name: "f", type: "custom", options: ["a"] }],
      panels: [panel("p1", "Orders")],
    });
    const { user } = renderApp("/dashboards/d-main/settings?section=variables");
    const editor = await screen.findByRole("region", { name: "f" });
    await pickOption(
      user,
      within(editor).getByRole("combobox", { name: "Kind" }),
      "Ad hoc filters",
    );
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    expect(await within(editor).findByText("Pick the filters’ data source.")).toBeTruthy();
    await pickOption(
      user,
      within(editor).getByRole("combobox", { name: "Data source" }),
      "Sales DB",
    );
    expect(within(editor).getByText(/Typed SQL queries need \$__filter/)).toBeTruthy();
    expect(within(editor).getByRole("button", { name: "Add filter" })).toBeTruthy();
  });

  it("shows the dependencies as a graph and a table, and removes an unused variable", async () => {
    setup("editor", {
      ...emptyModel("Main"),
      variables: [
        {
          name: "region",
          type: "query",
          datasourceId: PG_ID,
          query: { sql: "SELECT region FROM r" },
        },
        {
          name: "host",
          type: "query",
          datasourceId: PG_ID,
          query: { sql: "SELECT host FROM h WHERE region = $region" },
        },
        { name: "old", type: "custom", options: ["a"] },
      ],
      panels: [
        panel("p1", "CPU", {
          targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT $host, $job" } }],
        }),
      ],
    });
    const { user } = renderApp("/dashboards/d-main/settings?section=variables");
    await user.click(await screen.findByRole("tab", { name: "Dependencies" }));
    expect(screen.getByRole("img", { name: "Dependencies of the variables" })).toBeTruthy();
    const table = screen.getByRole("table");
    const row = (name: string) =>
      within(table).getByRole("row", { name: new RegExp(`^\\$${name}`) });
    expect(within(row("host")).getByText("$region")).toBeTruthy();
    expect(within(row("host")).getByText("CPU")).toBeTruthy();
    expect(within(row("region")).getByText("$host")).toBeTruthy();
    expect(
      screen.getByText("Unknown: CPU names $job, but there is no such variable."),
    ).toBeTruthy();
    await user.click(within(row("old")).getByRole("button", { name: "Remove variable old" }));
    expect(within(table).queryByRole("row", { name: /^\$old/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create variable job" }));
    expect(await screen.findByRole("region", { name: "job" })).toBeTruthy();
  });
});

describe("Prometheus helpers", () => {
  it("show the query behind them in the words of other tools", () => {
    expect(helperText({ helper: "labelValues", label: "job" })).toBe("label_values(job)");
    expect(
      helperText({ helper: "labelValues", label: "job", metric: "up", filter: 'env="$env"' }),
    ).toBe('label_values(up{env="$env"}, job)');
    expect(helperText({ helper: "labelNames", metric: "up" })).toBe("label_names(up)");
    expect(helperText({ helper: "metrics", regex: "node_.*" })).toBe("metrics(node_.*)");
    expect(helperText({ helper: "queryResult", expr: "topk(3, up)" })).toBe(
      "query_result(topk(3, up))",
    );
    expect(helperText({ expr: "up" })).toBe("");
    expect(hasQuery({ helper: "metrics" }, "prometheus")).toBe(true);
  });

  it("replace the typed query with a form and save the helper", async () => {
    const { stored } = setup("editor", {
      ...emptyModel("Main"),
      variables: [{ name: "job", type: "query", datasourceId: PROM_ID, query: { expr: "up" } }],
      panels: [panel("p1", "Orders")],
    });
    const { user } = renderApp("/dashboards/d-main/settings?section=variables");
    const editor = await screen.findByRole("region", { name: "job" });
    const mode = await within(editor).findByRole("combobox", { name: "What to query" });
    await pickOption(user, mode, "Label values");
    await user.click(within(editor).getByLabelText("Label"));
    await user.paste("job");
    await user.click(within(editor).getByLabelText("Only from metric (optional)"));
    await user.paste("up");
    expect(
      within(editor).getByRole("status", { name: "Query behind it (read-only)" }).textContent,
    ).toBe("label_values(up, job)");
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() =>
      expect(latest(stored).model.variables[0]?.query).toEqual({
        helper: "labelValues",
        label: "job",
        metric: "up",
      }),
    );
  });
});

describe("public pages", () => {
  it("show ad hoc filters only as their number", () => {
    const dashboard = {
      variables: [
        { name: "filters", type: "adhoc", label: "Filters", value: 2 },
        { name: "src", type: "datasource" },
        { name: "none", type: "adhoc", value: 0 },
      ],
    } as unknown as PublicDashboard;
    render(<FixedValues dashboard={dashboard} />);
    const list = screen.getByRole("list", { name: "Fixed values" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Filters: 2")).toBeTruthy();
  });
});
