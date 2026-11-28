import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Compiled, Pattern } from "../../api/generated/shapes";
import { chooseOption } from "../../test/select";
import { SHOP_SCHEMA, t } from "./test/fixtures";

const api = vi.hoisted(() => ({
  compile: vi.fn(),
}));

vi.mock("./api", () => ({
  GRAPH_PATTERNS_KEY: "graphPatterns",
  graphSchemaQuery: (orgId: string, id: string) =>
    queryOptions({
      queryKey: ["graphPatterns", orgId, "schema", id],
      queryFn: async () => SHOP_SCHEMA,
    }),
  compilePattern: api.compile,
  fetchGraphSchema: vi.fn(async () => SHOP_SCHEMA),
  countInSchema: vi.fn(),
  parsePattern: vi.fn(),
  fetchPlan: vi.fn(),
  fetchChoices: vi.fn(),
}));

const { PatternBuilder } = await import("./PatternBuilder");

/** Frame 1 of the board: "Kunden von $lieferant". */
const SUPPLIERS: Pattern = {
  nodes: [
    { id: "k", labels: ["Kunde"] },
    { id: "p", labels: ["Produkt"] },
    {
      id: "l",
      labels: ["Lieferant"],
      conditions: [{ property: "name", op: "eq", value: { param: "lieferant" } }],
    },
  ],
  edges: [
    { id: "e1", from: "k", to: "p", types: ["KAUFT"], direction: "out" },
    { id: "e2", from: "l", to: "p", types: ["LIEFERT"], direction: "out" },
  ],
  parameters: [{ name: "lieferant", type: "string" }],
};

const COMPILED: Compiled = {
  text: "MATCH kz_p0 = (k:Kunde)-[e1:KAUFT]->(p:Produkt)<-[e2:LIEFERT]-(l:Lieferant)\nWHERE l.name = $lieferant AND p.preis > $kz_v0\nRETURN kz_p0\nLIMIT 500",
  parameters: { kz_v0: 100 },
  limit: 500,
};

function Harness({
  initial,
  onEditAsText = () => undefined,
  onPendingText,
  onPattern,
}: {
  initial: Pattern;
  onEditAsText?: (text: string, params?: Record<string, unknown>) => void;
  onPendingText?: (pending: boolean) => void;
  onPattern?: (pattern: Pattern) => void;
}) {
  const [pattern, setPattern] = useState(initial);
  const [samples, setSamples] = useState<Record<string, unknown>>({});
  return (
    <PatternBuilder
      orgId="org"
      datasource={{ id: "ds", kind: "neo4j" }}
      pattern={pattern}
      onChange={(next) => {
        setPattern(next);
        onPattern?.(next);
      }}
      samples={samples}
      onSamples={setSamples}
      onEditAsText={onEditAsText}
      onPendingText={onPendingText}
    />
  );
}

function renderBuilder(props: Parameters<typeof Harness>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.compile.mockReset();
  api.compile.mockResolvedValue(COMPILED);
});

describe("pattern builder", () => {
  it("starts empty with the labels of the source and draws the first node from one", async () => {
    const onPattern = vi.fn();
    renderBuilder({ initial: { nodes: [] }, onPattern });
    expect(screen.getByRole("heading", { name: t("graphPatterns.empty.title") })).toBeTruthy();
    const kunde = await screen.findByRole("button", {
      name: t("graphPatterns.panel.labelCount", { name: "Kunde", count: "5" }),
    });
    fireEvent.click(kunde);
    expect(onPattern).toHaveBeenLastCalledWith({ nodes: [{ id: "k", labels: ["Kunde"] }] });
    // The drawing is a picture named by the sentence; the list is the same for the keyboard.
    expect(screen.getByRole("img", { name: "Find Kunde k. At most 500 matches." })).toBeTruthy();
    // The new node is chosen: its fields stand beside the drawing.
    expect(
      screen.getByRole("heading", { name: t("graphPatterns.panel.node", { id: "k" }) }),
    ).toBeTruthy();
  });

  it("says the pattern in a sentence and shows the query the server writes, read-only", async () => {
    const onEditAsText = vi.fn();
    renderBuilder({ initial: SUPPLIERS, onEditAsText });
    expect(
      screen.getByText(
        "Find Kunde k, Produkt p, and Lieferant l. k has an edge KAUFT to p. l has an edge LIEFERT to p. For l: name is $lieferant. At most 500 matches.",
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(/WHERE l\.name = \$lieferant AND p\.preis > \$kz_v0/),
    ).toBeTruthy();
    // The template's parameter without a sample value is left out of the compile request.
    expect(api.compile).toHaveBeenCalledWith("org", "ds", SUPPLIERS, {}, expect.anything());
    fireEvent.click(
      screen.getByRole("button", {
        name: t("graphPatterns.query.editAsText", { language: "Cypher" }),
      }),
    );
    // Kalzit's own literal goes into the text as a literal; the template's parameter stays.
    expect(onEditAsText).toHaveBeenCalledWith(
      "MATCH kz_p0 = (k:Kunde)-[e1:KAUFT]->(p:Produkt)<-[e2:LIEFERT]-(l:Lieferant)\nWHERE l.name = $lieferant AND p.preis > 100\nRETURN kz_p0\nLIMIT 500",
      undefined,
    );
  });

  it("holds the run while a variable has no sample value, and sends the value once given", async () => {
    const onPendingText = vi.fn();
    renderBuilder({ initial: SUPPLIERS, onPendingText });
    expect(onPendingText).toHaveBeenLastCalledWith(true);
    expect(
      screen.getByText(t("graphPatterns.parameters.missing", { name: "lieferant" })),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByRole("textbox", {
        name: t("graphPatterns.parameters.sampleOf", { name: "lieferant" }),
      }),
      { target: { value: "Nordhandel GmbH" } },
    );
    await waitFor(() => expect(onPendingText).toHaveBeenLastCalledWith(false));
    await waitFor(() =>
      expect(api.compile).toHaveBeenLastCalledWith(
        "org",
        "ds",
        SUPPLIERS,
        { lieferant: "Nordhandel GmbH" },
        expect.anything(),
      ),
    );
  });

  it("checks a value against the property's type and makes a value a typed variable", async () => {
    const onPattern = vi.fn();
    const onPendingText = vi.fn();
    renderBuilder({
      initial: { nodes: [{ id: "p", labels: ["Produkt"] }] },
      onPattern,
      onPendingText,
    });
    await screen.findByRole("heading", { name: t("graphPatterns.panel.node", { id: "p" }) });
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.panel.addCondition") }));
    chooseOption(
      screen.getByRole("combobox", { name: t("graphPatterns.condition.property") }),
      "preis",
    );
    const value = screen.getByRole("textbox", { name: t("graphPatterns.condition.value") });
    fireEvent.change(value, { target: { value: "viel" } });
    expect(
      screen.getByText(
        t("graphPatterns.condition.notNumber", { property: "preis", value: "viel" }),
      ),
    ).toBeTruthy();
    expect(onPendingText).toHaveBeenLastCalledWith(true);
    fireEvent.change(value, { target: { value: "$mindestpreis" } });
    const last = onPattern.mock.lastCall?.[0] as Pattern;
    expect(last.nodes[0]?.conditions).toEqual([
      { property: "preis", op: "eq", value: { param: "mindestpreis" } },
    ]);
    // A number property makes a number variable.
    expect(last.parameters).toEqual([{ name: "mindestpreis", type: "float" }]);
  });

  it("offers the edge types between the two labels first", async () => {
    renderBuilder({ initial: SUPPLIERS });
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.bar.list") }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edge e1 KAUFT/ }));
    const type = await screen.findByRole("combobox", { name: t("graphPatterns.panel.type") });
    fireEvent.click(type);
    const list = document.getElementById(type.getAttribute("aria-controls") ?? "");
    expect(list).not.toBeNull();
    const groups = within(list as HTMLElement).getAllByRole("group");
    const names = groups.map(
      (g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent,
    );
    expect(names).toEqual([
      t("graphPatterns.panel.between", { from: "Kunde", to: "Produkt" }),
      t("graphPatterns.panel.notBetween"),
    ]);
    const options = (group: HTMLElement | undefined) =>
      within(group as HTMLElement)
        .getAllByRole("option")
        .map((o) => o.dataset.value);
    expect(options(groups[0])).toEqual(["KAUFT"]);
    expect(options(groups[1])).toEqual(["LIEFERT", "EMPFAHL"]);
  });

  it("works with the keys of the board in the list", async () => {
    const onPattern = vi.fn();
    renderBuilder({ initial: SUPPLIERS, onPattern });
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.bar.list") }));
    const node = await screen.findByRole("button", { name: /^Node Lieferant l/ });
    fireEvent.keyDown(node, { key: "Enter" });
    expect(
      screen.getByRole("heading", { name: t("graphPatterns.panel.node", { id: "l" }) }),
    ).toBeTruthy();
    fireEvent.keyDown(node, { key: "Delete" });
    let last = onPattern.mock.lastCall?.[0] as Pattern;
    expect(last.nodes.map((n) => n.id)).toEqual(["k", "p"]);
    expect(last.edges?.map((e) => e.id)).toEqual(["e1"]);
    expect(last.parameters).toBeUndefined();
    const canvasNode = screen.getByRole("button", { name: /^Node Kunde k/ });
    fireEvent.keyDown(canvasNode, { key: "n" });
    last = onPattern.mock.lastCall?.[0] as Pattern;
    expect(last.nodes.map((n) => n.id)).toEqual(["k", "p", "n"]);
    // Typing in a field is no shortcut.
    const before = onPattern.mock.calls.length;
    fireEvent.keyDown(screen.getByRole("textbox", { name: t("graphPatterns.panel.name") }), {
      key: "n",
    });
    expect(onPattern.mock.calls.length).toBe(before);
    // L switches to the drawing, the same pattern as a picture.
    fireEvent.keyDown(screen.getByRole("button", { name: /^Node Kunde k/ }), { key: "l" });
    expect(screen.queryByRole("list", { name: t("graphPatterns.list.label") })).toBeNull();
    expect(
      screen.getByRole("img", { name: /^Find Kunde k, Produkt p, and any node n\./ }),
    ).toBeTruthy();
  });

  it("says when GSQL cannot run an optional part, and makes it required on request", async () => {
    const client = new QueryClient();
    const onChange = vi.fn();
    const optional: Pattern = {
      ...SUPPLIERS,
      edges: (SUPPLIERS.edges ?? []).map((e) => (e.id === "e2" ? { ...e, optional: true } : e)),
    };
    render(
      <QueryClientProvider client={client}>
        <PatternBuilder
          orgId="org"
          datasource={{ id: "ds", kind: "tigergraph" }}
          pattern={optional}
          onChange={onChange}
          onEditAsText={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(t("graphPatterns.query.gsqlOptional"))).toBeTruthy();
    expect(api.compile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.bar.list") }));
    fireEvent.click(screen.getByRole("button", { name: /^Edge e2 LIEFERT/ }));
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.panel.makeRequired") }));
    const last = onChange.mock.lastCall?.[0] as Pattern | undefined;
    expect(last?.edges?.[1]).toEqual({
      id: "e2",
      from: "l",
      to: "p",
      types: ["LIEFERT"],
      direction: "out",
    });
  });
});
