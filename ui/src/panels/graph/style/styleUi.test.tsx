import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Frame } from "../../../api/generated/shapes";
import { FAKE_GRAPH } from "../../../features/datasources/test/fakeGraph";
import { setLanguage, translate } from "../../../i18n/i18n";
import { pickOption } from "../../../test/select";
import { type PanelHost, PanelHostContext } from "../../host";
import { getPanel } from "../../registry";
import { StyleSourcesContext } from "../../styleSources";
import type { AnyPanelPlugin } from "../../types";
import { ruleSentence } from "./describe";
import { StyleEditor } from "./StyleEditor";
import { type GraphStyle, MAX_STYLE_RULES, parseGraphStyle } from "./schema";
import { captionColumn, tableLooks } from "./tableStyle";
import { vocabularyOf } from "./useGraphStyle";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);

const NODE_ITEMS = FAKE_GRAPH.nodes.map((n) => ({ kinds: n.labels, properties: n.properties }));
const EDGE_ITEMS = FAKE_GRAPH.edges.map((e) => ({ kinds: [e.type], properties: e.properties }));
const VOCABULARY = vocabularyOf(FAKE_GRAPH);

const PRICEY = parseGraphStyle({
  version: 1,
  nodes: [
    { id: "a", scope: "Customer", when: { kind: "always" }, set: { icon: "user" } },
    {
      id: "b",
      scope: "Product",
      when: { kind: "condition", property: "price", type: "number", op: "gte", value: "100" },
      set: { badge: "Top", color: "warning" },
    },
  ],
  edges: [{ id: "c", scope: "BOUGHT", when: { kind: "always" }, set: { dash: "dashed" } }],
});

function Editor({
  initial,
  sources,
}: {
  initial: GraphStyle;
  sources?: { id: string; title: string; style: GraphStyle }[];
}) {
  const [style, setStyle] = useState(initial);
  return (
    <>
      <StyleEditor
        rules={style}
        onChange={setStyle}
        items={{ nodes: NODE_ITEMS, edges: EDGE_ITEMS }}
        vocabulary={VOCABULARY}
        basis={{ color: "By label", size: "By degree", shape: "Per label" }}
        copySources={sources}
      />
      <output data-testid="stored">{JSON.stringify(style)}</output>
    </>
  );
}

const stored = (): GraphStyle => JSON.parse(screen.getByTestId("stored").textContent ?? "{}");

beforeEach(async () => {
  await setLanguage("en");
});

describe("rules in words", () => {
  it("reads each rule as a sentence: when, for which label, then what", () => {
    expect(ruleSentence(t, PRICEY.nodes[0] as never, "nodes")).toBe(
      "Always (Customer), then Icon user",
    );
    expect(ruleSentence(t, PRICEY.nodes[1] as never, "nodes")).toBe(
      "If price greater than or equal to 100 (Product), then Color Warning, Badge “Top”",
    );
    expect(ruleSentence(t, PRICEY.edges[0] as never, "edges")).toBe(
      "Always (BOUGHT), then Line style dashed",
    );
  });
});

describe("style editor", () => {
  it("lists the basis and the rules with how many each matches", () => {
    render(<Editor initial={PRICEY} />);
    expect(screen.getByText("Color (basis)")).toBeTruthy();
    const list = screen.getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("matches 2")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("matches 1")).toBeTruthy();
  });

  it("adds a condition rule, says when its value does not fit the type, and stores it", async () => {
    const user = userEvent.setup();
    render(<Editor initial={parseGraphStyle(undefined)} />);
    expect(screen.getByText("No rules yet")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Rule" }));
    await user.click(screen.getByRole("button", { name: "Condition" }));
    const property = screen.getByLabelText("Property");
    await user.clear(property);
    await user.type(property, "price");
    await pickOption(user, screen.getByLabelText("Data type"), "number");
    await pickOption(user, screen.getByLabelText("Comparison"), "gt");
    await user.type(screen.getByLabelText("Value"), "ten");
    expect(
      screen.getByText("“price” is a number. Enter a number, for example 10000."),
    ).toBeTruthy();
    await user.clear(screen.getByLabelText("Value"));
    await user.type(screen.getByLabelText("Value"), "100");
    await pickOption(user, screen.getByLabelText("Add target"), "shape");
    expect(screen.getByText("matches 1 of 4")).toBeTruthy();
    const rule = stored().nodes[0];
    expect(rule?.when).toMatchObject({
      kind: "condition",
      property: "price",
      op: "gt",
      value: "100",
    });
    expect(rule?.set).toEqual({ shape: "diamond" });
  });

  it("asks for a second cue next to a status color", async () => {
    const user = userEvent.setup();
    render(
      <Editor
        initial={parseGraphStyle({
          nodes: [{ id: "a", when: { kind: "always" }, set: { color: "critical" } }],
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Rule 1:/ }));
    expect(screen.getByRole("note").textContent).toMatch(/Add a second cue/);
    expect(screen.getByRole("radio", { name: "Critical" })).toHaveProperty("checked", true);
    // The palette never offers the accent color.
    expect(screen.queryByRole("radio", { name: /accent/i })).toBeNull();
  });

  it("moves a rule with Alt+Down; the lower rule wins", async () => {
    const user = userEvent.setup();
    render(<Editor initial={PRICEY} />);
    const first = screen.getByRole("button", { name: /Rule 1:/ });
    first.focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(stored().nodes.map((r) => r.id)).toEqual(["b", "a"]);
    expect(screen.getByText("Rule 1 is now rule 2.")).toBeTruthy();
  });

  it("names a rule whose property is not in the result as resting", () => {
    render(
      <Editor
        initial={parseGraphStyle({
          nodes: [
            {
              id: "a",
              when: { kind: "values", property: "segment", colors: [] },
              set: {},
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("resting: “segment” does not occur in the result")).toBeTruthy();
  });

  it("shows N of M values of a rule per unique value", async () => {
    const user = userEvent.setup();
    render(
      <Editor
        initial={parseGraphStyle({
          nodes: [{ id: "a", when: { kind: "values", property: "name", colors: [] }, set: {} }],
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Rule 1:/ }));
    expect(screen.getAllByText("4 of 4 values").length).toBeGreaterThan(0);
    await pickOption(user, screen.getByRole("combobox", { name: "Color for Ada" }), "good");
    expect(stored().nodes[0]?.when).toMatchObject({
      colors: [{ value: "Ada", color: "good" }],
    });
  });

  it("copies the rules of another panel without linking them", async () => {
    const user = userEvent.setup();
    render(
      <Editor
        initial={parseGraphStyle(undefined)}
        sources={[{ id: "p2", title: "Shop", style: PRICEY }]}
      />,
    );
    await pickOption(user, screen.getByLabelText("Take over rules from another panel"), "p2");
    await user.click(screen.getByRole("button", { name: "Take over" }));
    expect(stored().nodes).toHaveLength(2);
    expect(stored().edges).toHaveLength(1);
    expect(stored()).not.toBe(PRICEY);
  });

  it("stops adding rules at the limit", () => {
    const many = parseGraphStyle({
      nodes: Array.from({ length: MAX_STYLE_RULES }, (_, i) => ({
        id: `r${i}`,
        when: { kind: "always" },
        set: { size: 10 },
      })),
    });
    render(<Editor initial={many} />);
    expect(screen.getByRole("button", { name: "Rule" })).toHaveProperty("disabled", true);
    expect(screen.getByText(`At most ${MAX_STYLE_RULES} rules per panel.`)).toBeTruthy();
  });
});

describe("tables made from a graph", () => {
  const frame: Frame = {
    fields: [
      { name: "@labels", type: "json", values: [["Product"], ["Product"], ["Customer"]] },
      { name: "name", type: "string", values: ["Lamp", "Desk", "Ada"] },
      { name: "price", type: "number", values: [30, 250, null] },
    ],
  };

  it("puts the color at the column that decides it and icon, badge and label at the caption", () => {
    expect(captionColumn(frame)).toBe(1);
    const looks = tableLooks(frame, PRICEY);
    expect(looks?.cells[0]).toBeUndefined();
    expect(looks?.cells[1]?.get(2)).toEqual({ dot: "warning" });
    expect(looks?.cells[1]?.get(1)).toEqual({ badge: "Top" });
    expect(looks?.cells[2]?.get(1)).toEqual({ icon: "user" });
    expect(looks?.colored.get(2)).toBe(2);
  });

  it("takes only the color in an edge table", () => {
    const edges: Frame = {
      fields: [
        { name: "@type", type: "string", values: ["BOUGHT"] },
        { name: "quantity", type: "number", values: [2] },
      ],
    };
    const style = parseGraphStyle({
      edges: [{ id: "e", when: { kind: "always" }, set: { color: "chart-2", label: "x" } }],
    });
    expect(tableLooks(edges, style)?.cells[0]?.get(1)).toEqual({ dot: "chart-2" });
  });

  it("draws the rules in the table panel, and the rule wins over the column's colors", async () => {
    const plugin = getPanel("table") as AnyPanelPlugin;
    const { Panel } = plugin;
    render(
      <Panel
        frames={[frame]}
        options={plugin.options({ style: PRICEY })}
        fieldConfig={{
          defaults: { mappings: [{ type: "value", value: "250", text: "a lot" }] },
          overrides: [],
        }}
        timeRange={{ from: 0, to: 1 }}
        title="Products"
      />,
    );
    await waitFor(() => expect(screen.getByText("Top")).toBeTruthy());
    expect(screen.getByText("Warning:")).toBeTruthy();
    expect(screen.getByText(/Column price: rule 2 applies before/)).toBeTruthy();
  });
});

describe("graph panel", () => {
  it("opens the sheet Stil from the head and shows the rules in the legend", async () => {
    const user = userEvent.setup();
    const plugin = getPanel("network") as AnyPanelPlugin;
    const { Panel } = plugin;
    const host: PanelHost = {};
    render(
      <PanelHostContext value={host}>
        <StyleSourcesContext value={null}>
          <Panel
            frames={[]}
            graphs={[{ refId: "A", datasourceId: "ds", graph: FAKE_GRAPH }]}
            options={plugin.options({ style: PRICEY })}
            timeRange={{ from: 0, to: 1 }}
            title="Shop"
          />
        </StyleSourcesContext>
      </PanelHostContext>,
    );
    const button = await screen.findByRole(
      "button",
      { name: "Style (3 rules)" },
      { timeout: 4_000 },
    );
    const legend = screen.getByRole("list", { name: "Rules" });
    expect(within(legend).getByText("Customer")).toBeTruthy();
    await user.click(within(legend).getByRole("button", { name: /^Customer 2/ }));
    expect(screen.getAllByText(/2 selected|2 nodes selected|Selection: 2/).length).toBeGreaterThan(
      0,
    );
    await user.click(button);
    const sheet = screen.getByRole("region", { name: "Panel style" });
    expect(within(sheet).getByText(/apply only for you/)).toBeTruthy();
    await user.click(within(sheet).getByRole("checkbox", { name: "Rule 1 on" }));
    expect(within(sheet).getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(within(legend).queryByText("Customer")).toBeNull();
  });
});
