import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { pickOption } from "../test/select";
import { addStep, offeredSteps } from "../test/stepCatalog";
import { StepsEditor } from "./StepsEditor";
import { type NamedFrame, runSteps, type Step } from "./steps";

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
    await addStep(user, "Calculated field");
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
    // Shown at the step, not announced on every keystroke.
    expect(within(second).getByText("“*” cannot combine text and number.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
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
      within(screen.getByRole("listitem", { name: "Step 1" })).getByText(/no field “a”/),
    ).toBeTruthy();

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
    await addStep(user, "Group");
    expect(seen.steps[0]).toMatchObject({
      type: "group",
      by: ["land"],
      aggregations: [{ field: "betrag", op: "sum" }],
    });
    const step = screen.getByRole("listitem", { name: "Step 1" });
    expect(within(step).getByText("2 rows, 2 fields")).toBeTruthy();
    await pickOption(user, within(step).getByLabelText("Calculation"), "Mean");
    expect(seen.steps[0]).toMatchObject({ aggregations: [{ field: "betrag", op: "mean" }] });
    await user.click(within(step).getByRole("button", { name: "Add summary" }));
    await user.click(within(step).getByRole("button", { name: "Remove summary 1" }));
    expect(seen.steps[0]).toMatchObject({ aggregations: [{ field: "betrag", op: "sum" }] });
  });

  it("shows a projection of documents, and the steps after it work on its frame", async () => {
    const user = userEvent.setup();
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
              notices: [],
            },
          },
        ]}
      />,
    );
    const projection = screen.getByRole("listitem", { name: "Step 1" });
    expect(within(projection).getByText("Project into a table")).toBeTruthy();
    expect(within(projection).getByText(/query A: Stadt, summe\./)).toBeTruthy();
    expect(within(projection).getByText("2 rows, 2 fields")).toBeTruthy();
    const calculated = screen.getByRole("listitem", { name: "Step 2" });
    expect(within(calculated).getByText("2 rows, 3 fields")).toBeTruthy();
    // Not offered to add here: the query's editor makes projections.
    const { names } = await offeredSteps(user);
    expect(names).not.toContain("Project into a table");
  });

  it("keeps focus and the preview with a moved step and says where it went", async () => {
    const { user, seen } = setup([
      calc("s1", "a", "1"),
      calc("s2", "b", "2"),
      calc("s3", "c", "3"),
    ]);
    // The preview shows step 1; moving step 2 above it keeps the preview on the same step.
    await user.click(screen.getByRole("button", { name: "Preview after step 1" }));
    await user.click(screen.getByRole("button", { name: "Move step 2 up" }));
    expect(seen.steps.map((s) => s.id)).toEqual(["s2", "s1", "s3"]);
    expect(screen.getByRole("region", { name: "After step 2" })).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move step 1 down");
    expect(screen.getByText("The step is now step 1.")).toBeTruthy();
    // At the top, focus stays on the step's other move button.
    expect(screen.getByRole("button", { name: "Move step 1 up" }).hasAttribute("disabled")).toBe(
      true,
    );

    await user.click(screen.getByRole("button", { name: "Move step 3 up" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move step 2 up");
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(seen.steps.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove step 2");
    expect(screen.getByText("Step 2 removed.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add step" }));
  });

  it("shows each step its own result when the run is of the list before a move", () => {
    const steps = [calc("s1", "a", "1"), calc("s2", "b", "land * 2")];
    // The run of the old order: s1 fine, s2 failing.
    const run = runSteps(steps, FRAMES);
    render(
      <StepsEditor
        steps={[steps[1] as Step, steps[0] as Step]}
        onChange={() => {}}
        refIds={["A"]}
        inputs={FRAMES}
        run={run}
      />,
    );
    // s2 is now step 1 and still shows its own error; s1 its own result.
    expect(
      within(screen.getByRole("listitem", { name: "Step 1" })).getByText(/cannot combine/),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("listitem", { name: "Step 2" })).queryByText(/cannot combine/),
    ).toBeNull();
  });

  it("announces the same words again as a new message", async () => {
    const { user } = setup([calc("s1", "a", "1"), calc("s2", "b", "2"), calc("s3", "c", "3")]);
    await user.click(screen.getByRole("button", { name: "Move step 3 up" }));
    const first = screen.getByText("The step is now step 2.");
    await user.click(screen.getByRole("button", { name: "Move step 3 up" }));
    const second = screen.getByText("The step is now step 2.");
    expect(second).not.toBe(first);
  });

  it("offers joins only when there is a second query", async () => {
    const { user } = setup();
    const { names, unavailable } = await offeredSteps(user);
    expect(unavailable).toContain("Join queries");
    expect(unavailable).toContain("Stack tables");
    expect(names).toContain("Compare with previous period");
    expect(unavailable).not.toContain("Compare with previous period");
  });

  it("arranges, hides and renames fields in the step's own list", async () => {
    const { user, seen } = setup();
    await addStep(user, "Arrange and rename fields");
    const step = screen.getByRole("listitem", { name: "Step 1" });
    await user.click(within(step).getByRole("button", { name: "Move betrag up" }));
    expect(seen.steps[0]).toMatchObject({ type: "organize", order: ["betrag", "land"] });
    await user.click(within(step).getByRole("checkbox", { name: "Show land" }));
    expect(seen.steps[0]).toMatchObject({ hide: ["land"] });
    await user.type(within(step).getByRole("textbox", { name: "New name for betrag" }), "Betrag");
    expect(seen.steps[0]).toMatchObject({ rename: { betrag: "Betrag" } });
    expect(within(step).getByText("3 rows, 1 fields")).toBeTruthy();
  });

  it("filters rows by conditions and says how many rows stay", async () => {
    const { user, seen } = setup();
    await addStep(user, "Filter rows");
    const step = screen.getByRole("listitem", { name: "Step 1" });
    expect(seen.steps[0]).toMatchObject({
      type: "filterRows",
      conditions: [{ field: "betrag", op: "notEmpty" }],
    });
    await pickOption(user, within(step).getByLabelText("Comparison"), "greater than");
    await user.type(within(step).getByLabelText("Value"), "15");
    expect(seen.steps[0]).toMatchObject({
      conditions: [{ field: "betrag", op: "gt", value: "15" }],
    });
    expect(within(step).getByText("Keeps 2 of 3 rows")).toBeTruthy();
    await pickOption(user, within(step).getByLabelText("These rows"), "Leave out");
    expect(within(step).getByText("Keeps 1 of 3 rows")).toBeTruthy();
  });

  it("converts a field and reduces the series, each with its help", async () => {
    const { user, seen } = setup();
    await addStep(user, "Convert type");
    const convert = screen.getByRole("listitem", { name: "Step 1" });
    expect(within(convert).getByText(/Turns a field into another type in its place/)).toBeTruthy();
    expect(seen.steps[0]).toMatchObject({ conversions: [{ field: "land", to: "number" }] });
    await pickOption(user, within(convert).getByLabelText("Into"), "time");
    await user.type(within(convert).getByLabelText("Time format, optional"), "YYYY");
    expect(seen.steps[0]).toMatchObject({
      conversions: [{ field: "land", to: "time", format: "YYYY" }],
    });
    await addStep(user, "Reduce");
    const reduce = screen.getByRole("listitem", { name: "Step 2" });
    expect(seen.steps[1]).toMatchObject({ mode: "rows", calculations: ["last", "mean", "max"] });
    await user.click(within(reduce).getByRole("checkbox", { name: "Sum" }));
    expect(seen.steps[1]).toMatchObject({ calculations: ["sum", "mean", "max", "last"] });
  });
});
