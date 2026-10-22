import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { StepsEditor } from "./StepsEditor";
import type { NamedFrame, Step } from "./steps";

const FRAMES: NamedFrame[] = [
  {
    name: "A",
    frame: {
      fields: [
        { name: "land", type: "string", values: ["AT", "CH", "AT"] },
        { name: "betrag", type: "number", values: [10, 20, 30] },
      ],
    },
  },
];

/** The editor with its steps in state, and the last list it reported. */
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
      inputs={FRAMES}
    />
  );
}

function setup(initial: Step[] = []) {
  const seen = { steps: initial };
  const user = userEvent.setup();
  render(<Harness initial={initial} seen={seen} />);
  return { user, seen };
}

const calc = (id: string, name: string, expression: string): Step => ({
  id,
  type: "calculate",
  frame: "A",
  name,
  expression,
});

describe("steps editor", () => {
  it("adds a calculated field and previews the result after it", async () => {
    const { user, seen } = setup();
    expect(screen.getByText("No steps yet.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add step" }));
    expect(seen.steps).toHaveLength(1);
    expect(seen.steps[0]).toMatchObject({ type: "calculate", frame: "A", expression: "betrag" });

    const step = screen.getByRole("listitem", { name: "Step 1" });
    const expression = within(step).getByLabelText("Expression");
    await user.clear(expression);
    await user.click(expression);
    await user.paste("betrag * 2");
    expect(seen.steps[0]).toMatchObject({ expression: "betrag * 2" });
    expect(within(step).getByText("3 rows, 3 fields")).toBeTruthy();

    await user.click(within(step).getByRole("button", { name: "Preview after step 1" }));
    const preview = screen.getByRole("region", { name: "After step 1" });
    expect(within(preview).getByRole("columnheader", { name: "Calculated" })).toBeTruthy();
    expect(within(preview).getByRole("cell", { name: "60" })).toBeTruthy();
  });

  it("shows syntax and type errors at the step", async () => {
    const { user } = setup([calc("s1", "x", "betrag +"), calc("s2", "y", "land * 2")]);
    const first = screen.getByRole("listitem", { name: "Step 1" });
    // At the field while typing, and as the step's state.
    expect(within(first).getAllByText("Unexpected input at character 9.")).toHaveLength(2);
    const second = screen.getByRole("listitem", { name: "Step 2" });
    expect(within(second).getByText("Not run, an earlier step failed")).toBeTruthy();
    // Fixing the first lets the second run, which names its own problem in words.
    const expression = within(first).getByLabelText("Expression");
    await user.clear(expression);
    await user.click(expression);
    await user.paste("betrag + 1");
    expect(within(second).getByRole("alert").textContent).toBe(
      "“*” cannot combine text and number.",
    );
  });

  it("reorders, turns off and removes steps", async () => {
    const { user, seen } = setup([calc("s1", "a", "1"), calc("s2", "b", "a + 1")]);
    const second = screen.getByRole("listitem", { name: "Step 2" });
    expect(screen.getByRole("button", { name: "Move step 1 up" }).hasAttribute("disabled")).toBe(
      true,
    );
    await user.click(within(second).getByRole("button", { name: "Move step 2 up" }));
    expect(seen.steps.map((s) => s.id)).toEqual(["s2", "s1"]);
    // Now "b" runs before "a" exists.
    expect(
      within(screen.getByRole("listitem", { name: "Step 1" })).getByRole("alert").textContent,
    ).toMatch(/no field “a”/);

    await user.click(
      within(screen.getByRole("listitem", { name: "Step 1" })).getByRole("checkbox", {
        name: "Active",
      }),
    );
    expect(seen.steps[0]?.disabled).toBe(true);
    expect(
      within(screen.getByRole("listitem", { name: "Step 1" })).getByText("Turned off"),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(seen.steps.map((s) => s.id)).toEqual(["s1"]);
    const active = within(screen.getByRole("listitem", { name: "Step 1" })).getByRole("checkbox", {
      name: "Active",
    });
    await user.click(active);
    expect(seen.steps[0]?.disabled).toBe(true);
    await user.click(active);
    expect(seen.steps[0]).not.toHaveProperty("disabled");
  });

  it("groups by a field with summaries picked from the fields", async () => {
    const { user, seen } = setup();
    await user.selectOptions(screen.getByLabelText("Kind of step"), "Group");
    await user.click(screen.getByRole("button", { name: "Add step" }));
    expect(seen.steps[0]).toMatchObject({
      type: "group",
      by: ["land"],
      aggregations: [{ field: "betrag", op: "sum" }],
    });
    const step = screen.getByRole("listitem", { name: "Step 1" });
    expect(within(step).getByText("2 rows, 2 fields")).toBeTruthy();
    await user.selectOptions(within(step).getByLabelText("Calculation"), "Mean");
    expect(seen.steps[0]).toMatchObject({ aggregations: [{ field: "betrag", op: "mean" }] });
    await user.click(within(step).getByRole("button", { name: "Add summary" }));
    await user.click(within(step).getByRole("button", { name: "Remove summary 1" }));
    expect(seen.steps[0]).toMatchObject({ aggregations: [{ field: "betrag", op: "sum" }] });
  });

  it("shows a projection of documents, and the steps after it work on its frame", () => {
    const steps: Step[] = [
      {
        id: "p",
        type: "toFrame",
        frame: "A",
        columns: [{ path: "kunde.stadt", name: "Stadt" }, { path: "summe" }],
      },
      calc("c", "doppelt", "summe * 2"),
    ];
    render(
      <StepsEditor
        steps={steps}
        onChange={() => {}}
        refIds={["A"]}
        inputs={[
          {
            name: "A",
            documents: {
              documents: [
                { kunde: { stadt: "Wien" }, summe: 3 },
                { kunde: { stadt: "Graz" }, summe: 4 },
              ],
              schema: [],
            },
          },
        ]}
      />,
    );
    const projection = screen.getByRole("listitem", { name: "Step 1" });
    expect(within(projection).getByText("Documents as a table")).toBeTruthy();
    expect(within(projection).getByText(/query A: Stadt, summe\./)).toBeTruthy();
    expect(within(projection).getByText("2 rows, 2 fields")).toBeTruthy();
    const calculated = screen.getByRole("listitem", { name: "Step 2" });
    expect(within(calculated).getByText("2 rows, 3 fields")).toBeTruthy();
    // Not offered to add here: the query's editor makes projections.
    const kinds = within(screen.getByLabelText("Kind of step"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(kinds).not.toContain("Documents as a table");
  });

  it("offers joins only when there is a second query", () => {
    setup();
    const kinds = within(screen.getByLabelText("Kind of step"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(kinds).not.toContain("Join queries");
    expect(kinds).toContain("Compare with previous period");
  });
});
