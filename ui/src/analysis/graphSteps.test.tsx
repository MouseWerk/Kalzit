import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { GraphSet } from "../api/generated/shapes";
import { StepsEditor } from "./StepsEditor";
import { type NamedInput, runSteps, type Step } from "./steps";

/** Two customers who bought the same product. */
const GRAPH: GraphSet = {
  nodes: [
    { id: "k1", labels: ["Kunde"], properties: { name: "Anna" } },
    { id: "k2", labels: ["Kunde"], properties: { name: "Ben" } },
    { id: "p1", labels: ["Produkt"], properties: { name: "Abo" } },
  ],
  edges: [
    { id: "e1", type: "KAUFTE", from: "k1", to: "p1", properties: {} },
    { id: "e2", type: "KAUFTE", from: "k2", to: "p1", properties: {} },
  ],
  schema: {
    labels: ["Kunde", "Produkt"],
    edgeTypes: ["KAUFTE"],
    propertyKeys: { Kunde: ["name"], Produkt: ["name"] },
  },
};

const INPUTS: NamedInput[] = [{ name: "A", graph: GRAPH }];

function Harness({ initial, seen }: { initial: Step[]; seen: { steps: Step[] } }) {
  const [steps, setSteps] = useState(initial);
  return (
    <StepsEditor
      steps={steps}
      onChange={(next) => {
        seen.steps = next;
        setSteps(next);
      }}
      refIds={["A"]}
      inputs={INPUTS}
      kindOf={() => "neo4j"}
    />
  );
}

function setup(initial: Step[] = []) {
  const seen = { steps: initial };
  const user = userEvent.setup();
  render(<Harness initial={initial} seen={seen} />);
  return { user, seen };
}

const options = () =>
  within(screen.getByLabelText("Kind of step"))
    .getAllByRole("option")
    .map((o) => o.textContent);

describe("graph steps in the steps editor", () => {
  it("offers graph steps for a graph, table steps only after a step that makes a table", async () => {
    const { user, seen } = setup();
    expect(options()).toContain("Count per label");
    expect(options()).toContain("Turn into a table");
    expect(options()).not.toContain("Group");
    expect(screen.getByText(/Table steps follow a step that makes a table/)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Kind of step"), "Count per label");
    await user.click(screen.getByRole("button", { name: "Add step" }));
    expect(seen.steps[0]).toMatchObject({ type: "countLabels", frame: "A" });
    const step = screen.getByRole("listitem", { name: "Step 1" });
    // The shape change is visible at the step, with where it runs.
    expect(within(step).getByText("Graph → Table")).toBeTruthy();
    expect(within(step).getByText("Runs in Neo4j (Cypher) · changes the shape")).toBeTruthy();
    expect(within(step).getByText("2 rows, 3 fields")).toBeTruthy();

    // Now there is a table and no graph left: table steps, no graph steps.
    expect(options()).toContain("Group");
    expect(options()).not.toContain("Count per label");
    // The chain of shapes names each step's result.
    const chain = screen.getByRole("list", { name: "Shapes of the steps" });
    expect(within(chain).getByText("3 nodes, 2 edges")).toBeTruthy();
    expect(within(chain).getByText("2 rows, 3 fields")).toBeTruthy();
  });

  it("edits shared neighbours from the graph's labels and runs a later step on the server", async () => {
    const shared: Step = {
      id: "s",
      type: "sharedNeighbours",
      frame: "A",
      label: "Kunde",
      via: "Produkt",
      min: 1,
      limit: 10,
    };
    const top: Step = { id: "t", type: "topDegree", frame: "A", n: 3 };
    const { user, seen } = setup([top, shared]);
    const second = screen.getByRole("listitem", { name: "Step 2" });
    // Only the first graph step of a query runs in the database.
    expect(within(second).getByText("Runs on the server · changes the shape")).toBeTruthy();
    expect(
      within(screen.getByRole("listitem", { name: "Step 1" })).getByText("Runs in Neo4j (Cypher)"),
    ).toBeTruthy();
    await user.selectOptions(within(second).getByLabelText("Name nodes by"), "name");
    expect(seen.steps[1]).toMatchObject({ name: "name" });
    await user.selectOptions(within(second).getByLabelText("Edge type"), "KAUFTE");
    expect(seen.steps[1]).toMatchObject({ edgeType: "KAUFTE" });
    await user.selectOptions(within(second).getByLabelText("Edge type"), "All");
    expect(seen.steps[1]).not.toHaveProperty("edgeType");
    await user.click(within(second).getByRole("button", { name: "Preview after step 2" }));
    const preview = screen.getByRole("region", { name: "After step 2" });
    expect(within(preview).getByRole("cell", { name: "Anna" })).toBeTruthy();
  });
});

describe("graph steps that stay a graph", () => {
  it("filter a subgraph by label and a property condition, and add the degree", async () => {
    const { user, seen } = setup();
    await user.selectOptions(screen.getByLabelText("Kind of step"), "Filter subgraph");
    await user.click(screen.getByRole("button", { name: "Add step" }));
    const step = screen.getByRole("listitem", { name: "Step 1" });
    expect(within(step).getByText("Graph")).toBeTruthy();
    expect(within(step).getByText("3 nodes, 2 edges")).toBeTruthy();
    await user.click(within(step).getByRole("checkbox", { name: "Kunde" }));
    expect(seen.steps[0]).toMatchObject({ type: "filterGraph", labels: ["Kunde"] });
    await user.selectOptions(within(step).getByLabelText("Condition on the property"), "name");
    await user.selectOptions(within(step).getByLabelText("Comparison"), "is");
    await user.type(within(step).getByLabelText("Value"), "Anna");
    expect(seen.steps[0]).toMatchObject({ property: { key: "name", op: "eq", value: "Anna" } });
    expect(within(step).getByText("1 nodes, 0 edges")).toBeTruthy();

    // A graph is left, so graph steps are still offered: the degree as a property.
    await user.selectOptions(screen.getByLabelText("Kind of step"), "Calculate degree");
    await user.click(screen.getByRole("button", { name: "Add step" }));
    expect(seen.steps[1]).toMatchObject({ type: "degree", frame: "A" });
    const run = runSteps(seen.steps, INPUTS);
    expect(run.graphs[0]?.graph.nodes[0]?.properties).toEqual({ name: "Anna", degree: 0 });
  });
});

describe("graph steps the server ran", () => {
  const count: Step = { id: "c", type: "countLabels", frame: "A" };
  const top: Step = { id: "t", type: "topDegree", frame: "A", n: 2 };
  const answered = {
    name: "A",
    frame: {
      fields: [
        { name: "label", type: "string" as const, values: ["Kunde"] },
        { name: "nodes", type: "number" as const, values: [812] },
        { name: "share", type: "number" as const, values: [1] },
      ],
    },
  };

  it("pass when the inputs already are the server's results", () => {
    const run = runSteps([count], [answered], {
      server: { ran: new Map([["c", { ranIn: "database" }]]) },
    });
    expect(run.failed).toBeUndefined();
    expect(run.steps[0]?.ranIn).toBe("database");
    expect(run.frames[0]?.frame.fields[1]?.values).toEqual([812]);
  });

  it("take the server's result at its last step and preview the steps before it", () => {
    const run = runSteps([top, count], INPUTS, {
      server: {
        ran: new Map([
          ["t", { ranIn: "database" }],
          ["c", { ranIn: "server" }],
        ]),
        results: new Map([["A", answered]]),
      },
    });
    expect(run.failed).toBeUndefined();
    // The preview of step 1 is computed here, on the graph the browser holds.
    expect(run.steps[0]?.graphs?.[0]?.graph.nodes.map((n) => n.id)).toEqual(["p1", "k1"]);
    expect(run.steps[1]?.ranIn).toBe("server");
    expect(run.frames[0]?.frame.fields[1]?.values).toEqual([812]);
  });

  it("show why a step failed on the server", () => {
    const run = runSteps([count], [answered], {
      server: {
        ran: new Map([
          [
            "c",
            {
              ranIn: "server" as const,
              error: {
                code: "validation",
                message: "the result A is no graph",
                reason: "steps.not_graph",
                params: { frame: "A" },
              },
            },
          ],
        ]),
      },
    });
    expect(run.failed?.error.reason).toBe("steps.not_graph");
  });

  it("run in the browser before the server answered", () => {
    const run = runSteps([count], INPUTS);
    expect(run.steps[0]?.ranIn).toBeUndefined();
    expect(run.frames[0]?.frame.fields[0]?.values).toEqual(["Kunde", "Produkt"]);
    expect(run.graphs).toEqual([]);
  });
});
