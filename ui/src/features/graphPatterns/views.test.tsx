import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphSourceSchema, PlanOperator, QueryPlan } from "../../api/generated/shapes";
import { SHOP_SCHEMA, t } from "./test/fixtures";

const api = vi.hoisted(() => ({
  schema: { current: undefined as unknown },
  plan: vi.fn(),
  count: vi.fn(),
  choices: vi.fn(),
}));

vi.mock("./api", () => ({
  GRAPH_PATTERNS_KEY: "graphPatterns",
  graphSchemaQuery: (orgId: string, id: string) =>
    queryOptions({
      queryKey: ["graphPatterns", orgId, "schema", id],
      queryFn: async () => {
        if (api.schema.current instanceof Error) throw api.schema.current;
        return api.schema.current as GraphSourceSchema;
      },
    }),
  fetchGraphSchema: vi.fn(async () => api.schema.current),
  countInSchema: api.count,
  fetchPlan: api.plan,
  fetchChoices: api.choices,
  compilePattern: vi.fn(),
  parsePattern: vi.fn(),
}));

const { GraphSchemaView } = await import("./GraphSchemaView");
const { PlanView, planHints, planRows } = await import("./PlanView");
const { readInputs, TemplateInputsEditor, TemplateRunInputs } = await import("./TemplateInputs");

/** Frame 12: "Kunden von $lieferant" with a choice of suppliers and a least amount. */
const TEMPLATE_INPUTS = [
  {
    name: "lieferant",
    type: "string" as const,
    label: "Lieferant",
    choices: { label: "Lieferant", property: "name" },
  },
  { name: "mindest", type: "integer" as const, label: "Mindestbetrag" },
];

function Inputs({ onRun }: { onRun: (variables: Record<string, unknown>) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return (
    <TemplateRunInputs
      orgId="org"
      analysisId="a1"
      parameters={TEMPLATE_INPUTS}
      values={values}
      busy={false}
      ran={false}
      onValues={setValues}
      onRun={onRun}
    />
  );
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  api.schema.current = SHOP_SCHEMA;
  api.plan.mockReset();
  api.count.mockReset();
  api.choices.mockReset();
  api.choices.mockResolvedValue({ values: ["Nordhandel GmbH", "Südvertrieb KG"], more: false });
});

describe("schema of a graph source", () => {
  it("draws labels with their counts and opens a label's properties and edges", async () => {
    const onUseLabel = vi.fn();
    wrap(
      <GraphSchemaView
        orgId="org"
        datasource={{ id: "ds", kind: "neo4j" }}
        onUseLabel={onUseLabel}
      />,
    );
    // The drawing is a picture that names its labels; the list opens them with the keyboard.
    expect(
      await screen.findByRole("img", {
        name: t("graphPatterns.schema.drawing", {
          labels: "Kunde, 5 nodes; Produkt, 6 nodes; Lieferant, 2 nodes",
        }),
      }),
    ).toBeTruthy();
    expect(screen.getByText(/^Schema from Neo4j: 3 labels, 3 edge types\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.schema.list") }));
    fireEvent.click(screen.getByRole("button", { name: /^Kunde/ }));
    const properties = screen.getByRole("table", { name: t("graphPatterns.schema.properties") });
    expect(within(properties).getByRole("cell", { name: "kundennr" })).toBeTruthy();
    expect(
      within(properties).getAllByRole("cell", { name: t("graphPatterns.kind.number") }),
    ).toHaveLength(1);
    const edges = screen.getByRole("table", { name: t("graphPatterns.schema.edges") });
    expect(within(edges).getByRole("cell", { name: "→ Produkt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.schema.use") }));
    expect(onUseLabel).toHaveBeenCalledWith("Kunde");
  });

  it("names a sample a sample and counts a label on request", async () => {
    api.schema.current = {
      ...SHOP_SCHEMA,
      source: "sample",
      sampleSize: 10_000,
      labels: SHOP_SCHEMA.labels.map(({ count: _count, ...l }) => l),
    };
    api.count.mockResolvedValue(18_240);
    wrap(<GraphSchemaView orgId="org" datasource={{ id: "ds", kind: "memgraph" }} />);
    expect(await screen.findByText(t("graphPatterns.schema.sample"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.schema.list") }));
    fireEvent.click(screen.getByRole("button", { name: /^Kunde/ }));
    expect(screen.getByText(t("graphPatterns.schema.labelNoCount"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.schema.count") }));
    await waitFor(() =>
      expect(
        screen.getByText(t("graphPatterns.schema.labelCount", { count: "18,240" })),
      ).toBeTruthy(),
    );
    expect(api.count).toHaveBeenCalledWith("org", "ds", { label: "Kunde" });
  });

  it("says when the schema could not be read, and that queries keep running", async () => {
    api.schema.current = new Error("refused");
    wrap(<GraphSchemaView orgId="org" datasource={{ id: "ds", kind: "neo4j" }} />);
    expect(await screen.findByText(t("graphPatterns.schema.failed"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("graphPatterns.schema.retry") })).toBeTruthy();
  });

  it("says when the database has no nodes yet", async () => {
    api.schema.current = { ...SHOP_SCHEMA, labels: [], edgeTypes: [], links: [] };
    wrap(<GraphSchemaView orgId="org" datasource={{ id: "ds", kind: "neo4j" }} />);
    expect(await screen.findByText(t("graphPatterns.schema.empty"))).toBeTruthy();
  });
});

/** Frame 21: the plan of "Kunden von $lieferant", measured. */
function op(
  operator: string,
  rest: Partial<PlanOperator>,
  ...children: PlanOperator[]
): PlanOperator {
  return { operator, children, ...rest };
}
const PLAN: QueryPlan = {
  mode: "profile",
  available: true,
  totalDbHits: 15,
  root: op(
    "ProduceResults@neo4j",
    { rows: 2, dbHits: 0, estimatedRows: 2 },
    op(
      "Limit@neo4j",
      { rows: 2, dbHits: 0, estimatedRows: 2 },
      op(
        "Expand(All)@neo4j",
        { rows: 2, dbHits: 5, estimatedRows: 5, details: "(p)<-[:KAUFT]-(k)" },
        op(
          "Filter@neo4j",
          { rows: 1, dbHits: 4, estimatedRows: 1, details: "l.name = $lieferant" },
          op("NodeByLabelScan@neo4j", {
            rows: 2,
            dbHits: 3,
            estimatedRows: 2,
            details: "l:Lieferant",
          }),
        ),
      ),
    ),
  ),
};

describe("query plan", () => {
  it("reads the tree top down and finds the index hint", () => {
    const rows = planRows(PLAN.root as PlanOperator);
    expect(rows.map((r) => [r.op.operator, r.depth])).toEqual([
      ["ProduceResults@neo4j", 0],
      ["Limit@neo4j", 1],
      ["Expand(All)@neo4j", 2],
      ["Filter@neo4j", 3],
      ["NodeByLabelScan@neo4j", 4],
    ]);
    expect(planHints(rows)).toEqual(["index"]);
  });

  it("plans on request, asks before measuring, and says each step in a sentence", async () => {
    api.plan.mockImplementation(async (_org: string, _ds: string, body: { mode: string }) =>
      body.mode === "explain" ? { ...PLAN, mode: "explain" } : PLAN,
    );
    const query = { cypher: "MATCH (l:Lieferant) WHERE l.name = $lieferant RETURN l" };
    wrap(
      <PlanView
        orgId="org"
        datasource={{ id: "ds", kind: "neo4j" }}
        query={query}
        variables={{ lieferant: "Nordhandel GmbH" }}
      />,
    );
    // No plan without asking (decision 17).
    expect(api.plan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.plan.explain") }));
    expect(await screen.findByText(t("graphPatterns.plan.explained"))).toBeTruthy();
    expect(api.plan).toHaveBeenLastCalledWith("org", "ds", {
      query,
      mode: "explain",
      variables: { lieferant: "Nordhandel GmbH" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.plan.profile") }));
    const dialog = screen.getByRole("dialog", { name: t("graphPatterns.plan.confirmTitle") });
    fireEvent.click(within(dialog).getByRole("button", { name: t("graphPatterns.plan.confirm") }));
    await waitFor(() =>
      expect(api.plan).toHaveBeenLastCalledWith(
        "org",
        "ds",
        expect.objectContaining({ mode: "profile" }),
      ),
    );
    const scan = await screen.findByRole("button", {
      name: `${t("graphPatterns.plan.step.labelScan.title")} NodeByLabelScan@neo4j`,
    });
    fireEvent.click(scan);
    expect(
      screen.getByText(t("graphPatterns.plan.step.labelScan.text", { details: "l:Lieferant" })),
    ).toBeTruthy();
    expect(screen.getByText(t("graphPatterns.plan.hint.index"))).toBeTruthy();
    expect(
      screen.getByText(/^Plan from Neo4j\..* 5 steps\. 15 database hits\. 2 rows\./),
    ).toBeTruthy();
  });

  it("says that GSQL has no plan, without asking the database", () => {
    wrap(
      <PlanView
        orgId="org"
        datasource={{ id: "ds", kind: "tigergraph" }}
        query={{ gsql: "INTERPRET QUERY () FOR GRAPH g { }" }}
        variables={{}}
      />,
    );
    expect(screen.getByText(t("graphPatterns.plan.gsqlTitle"))).toBeTruthy();
    expect(api.plan).not.toHaveBeenCalled();
  });
});

describe("search templates", () => {
  it("types the inputs a person gave and names what is missing or does not fit", () => {
    const parameters = [
      { name: "lieferant", type: "string" as const, label: "Lieferant" },
      { name: "mindest", type: "integer" as const },
      { name: "nummern", type: "integerList" as const },
      { name: "aktiv", type: "boolean" as const },
    ];
    expect(
      readInputs(parameters, { lieferant: "Nordhandel GmbH", mindest: "viel", nummern: "1\n2" }),
    ).toEqual({
      variables: { lieferant: "Nordhandel GmbH", nummern: [1, 2], aktiv: false },
      missing: [],
      wrong: ["mindest"],
    });
    expect(readInputs(parameters, {}).missing).toEqual(["lieferant", "mindest", "nummern"]);
  });

  it("runs only with fitting inputs, and offers the values of a property to choose from", async () => {
    const onRun = vi.fn();
    wrap(<Inputs onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.template.run") }));
    expect(onRun).not.toHaveBeenCalled();
    expect(
      screen.getByText(t("graphPatterns.template.missing", { name: "Lieferant" })),
    ).toBeTruthy();
    await waitFor(() =>
      expect(api.choices).toHaveBeenCalledWith("org", "a1", "lieferant", "", expect.anything()),
    );
    await waitFor(() => expect(document.querySelectorAll("datalist option")).toHaveLength(2));
    fireEvent.change(screen.getByRole("combobox", { name: "Lieferant" }), {
      target: { value: "Nordhandel GmbH" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Mindestbetrag" }), {
      target: { value: "viel" },
    });
    expect(
      screen.getByText(
        t("graphPatterns.template.wrong", {
          name: "Mindestbetrag",
          type: t("graphPatterns.type.integer"),
        }),
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Mindestbetrag" }), {
      target: { value: "5000" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("graphPatterns.template.run") }));
    expect(onRun).toHaveBeenCalledWith({ lieferant: "Nordhandel GmbH", mindest: 5000 });
  });

  it("sets labels and a choice from values when the template is saved", async () => {
    const onChange = vi.fn();
    wrap(
      <TemplateInputsEditor
        orgId="org"
        datasourceId="ds"
        parameters={[{ name: "lieferant", type: "string" }]}
        typesEditable={false}
        refId="A"
        onChange={onChange}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", {
        name: t("graphPatterns.template.labelOf", { name: "lieferant" }),
      }),
      { target: { value: "Lieferant" } },
    );
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "lieferant", type: "string", label: "Lieferant" },
    ]);
    const input = screen.getByRole("combobox", {
      name: t("graphPatterns.template.inputOf", { name: "lieferant" }),
    });
    // The choice opens once the schema is there; the list stays open while it arrives.
    fireEvent.click(input);
    const choice = () =>
      document
        .getElementById(input.getAttribute("aria-controls") ?? "")
        ?.querySelector<HTMLElement>('[data-value="choices"]');
    await waitFor(() => expect(choice()?.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(choice() as HTMLElement);
    // A pattern's parameter needs no refId: the pattern target declares it.
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "lieferant", type: "string", choices: { label: "Kunde", property: "name" } },
    ]);
  });
});
