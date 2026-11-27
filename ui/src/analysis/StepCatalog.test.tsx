import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { catalogNames, catalogOption, openCatalog } from "../test/stepCatalog";
import { type CatalogEntry, matchEntry, searchEntries } from "./StepCatalog";
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

function Harness({ seen, compact = false }: { seen: { steps: Step[] }; compact?: boolean }) {
  const [steps, setSteps] = useState<Step[]>([]);
  return (
    <StepsEditor
      compact={compact}
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

function setup(compact = false) {
  const seen = { steps: [] as Step[] };
  const user = userEvent.setup();
  render(<Harness seen={seen} compact={compact} />);
  return { user, seen };
}

const entry = (type: string, label: string, about: string, keywords: string[] = []) =>
  ({ key: type, type, label, about, keywords, from: "frame", to: "frame" }) as CatalogEntry;

describe("catalog search", () => {
  const entries = [
    entry("calculate", "Calculated field", "A new field from an expression.", ["rename"]),
    entry("organize", "Arrange and rename fields", "Order, names, show and hide.", ["rename"]),
    entry("pivot", "Pivot", "Values of a field as columns.", ["crosstab"]),
  ];

  it("ranks a hit in the name above one in the description above a keyword", () => {
    const hits = searchEntries(entries, "rename");
    expect(hits.map((h) => h.entry.type)).toEqual(["organize", "calculate"]);
    expect(hits[0]?.reason).toBe("name");
    expect(hits[1]?.reason).toEqual({ keyword: "rename" });
    expect(searchEntries(entries, "as columns").map((h) => h.entry.type)).toEqual(["pivot"]);
    expect(matchEntry(entries[2] as CatalogEntry, "a CROSSTAB please")?.reason).toEqual({
      keyword: "crosstab",
    });
    expect(searchEntries(entries, "dienstkarte")).toEqual([]);
    // An empty search lists everything in its order.
    expect(searchEntries(entries, "  ").map((h) => h.entry.type)).toEqual([
      "calculate",
      "organize",
      "pivot",
    ]);
  });
});

describe("the step catalog dialog", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows the table steps in their groups with what the result is before the step", async () => {
    const { user } = setup();
    const dialog = await openCatalog(user);
    // Rows: filter rows, sort and limit.
    expect(
      within(dialog)
        .getAllByRole("group")
        .map((g) => g.querySelector(".step-catalog__heading")?.textContent),
    ).toEqual(["Fields · 4", "Rows · 3", "Combine · 2", "Reshape · 2", "Calculate · 7"]);
    expect(
      within(dialog).getByText("The result before this step is a table: 3 rows, 2 fields"),
    ).toBeTruthy();
    const organize = catalogOption(dialog, "Arrange and rename fields");
    expect(organize.querySelector(".step-catalog__new")?.textContent).toBe("new");
    expect(
      catalogOption(dialog, "Calculated field").querySelector(".step-catalog__new"),
    ).toBeNull();
  });

  it("finds steps by generic keywords and says why", async () => {
    const { user } = setup();
    const dialog = await openCatalog(user);
    await user.type(within(dialog).getByRole("searchbox", { name: "Find a step" }), "merge");
    expect(catalogNames(dialog)).toEqual(["Stack tables"]);
    expect(within(dialog).getByText("Keyword: merge")).toBeTruthy();
    // A step that needs a second query is listed, says why, and is not added.
    expect(catalogOption(dialog, "Stack tables").getAttribute("aria-disabled")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  });

  it("walks the hits with the arrow keys and adds with Enter", async () => {
    const { user, seen } = setup(true);
    const dialog = await openCatalog(user);
    const search = within(dialog).getByRole("searchbox", { name: "Find a step" });
    await user.type(search, "field");
    const first = catalogNames(dialog)[0];
    expect(first).toBe("Arrange and rename fields");
    await user.keyboard("{ArrowDown}");
    const second = catalogNames(dialog)[1] as string;
    expect(search.getAttribute("aria-activedescendant")).toBe(catalogOption(dialog, second).id);
    await user.keyboard("{Enter}");
    expect(seen.steps).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Add step" })).toBeNull();
    // The new step opens for editing.
    expect(screen.getByRole("listitem", { name: "Step 1" })).toBeTruthy();
  });

  it("previews a step on the person's data and dims one that does not fit yet", async () => {
    const { user } = setup();
    const dialog = await openCatalog(user);
    await user.hover(catalogOption(dialog, "Limit"));
    const preview = within(dialog).getByRole("complementary");
    expect(within(preview).getByRole("heading", { name: "Limit" })).toBeTruthy();
    expect(within(preview).getByText("Before (your data)")).toBeTruthy();
    expect(within(preview).getByText("After (example)")).toBeTruthy();
    expect(within(preview).getAllByRole("cell", { name: "AT" }).length).toBeGreaterThan(0);
    // Comparing with a previous period needs a time field this table lacks.
    const compare = catalogOption(dialog, "Compare with previous period");
    expect(compare.getAttribute("data-dim")).toBe("true");
    await user.hover(compare);
    expect(within(preview).getByText(/^Does not fit your data yet/)).toBeTruthy();
  });

  it("offers the steps added last at the top", async () => {
    const { user, seen } = setup();
    let dialog = await openCatalog(user);
    expect(within(dialog).queryByText("Recent")).toBeNull();
    await user.click(catalogOption(dialog, "Limit"));
    expect(seen.steps[0]).toMatchObject({ type: "limit", count: 10 });
    dialog = await openCatalog(user);
    const recent = within(dialog).getByRole("group", { name: "Recent" });
    await user.click(within(recent).getByRole("button", { name: "Limit" }));
    expect(seen.steps.map((s) => s.type)).toEqual(["limit", "limit"]);
  });

  it("closes with Escape and returns the focus to Add step", async () => {
    const { user } = setup();
    await openCatalog(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add step" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add step" }));
  });
});
