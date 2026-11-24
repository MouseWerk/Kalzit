import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FieldConfigEditor } from "./FieldConfigEditor";

/** The label a closed select shows: its chosen option. */
function shown(select: HTMLElement): string {
  return select.querySelector(".select__label")?.textContent ?? "";
}

const TABLE = [
  "standard",
  "range",
  "thresholds",
  "mappings",
  "color",
  "table",
  "overrides",
] as const;

/**
 * Field options as the Grafana import writes them (the table of the real export in
 * `server/tests/fixtures/grafana/shop-ops.json`): everything it stores shows in the editor.
 */
const IMPORTED_TABLE = {
  defaults: {},
  overrides: [
    {
      matcher: { type: "name", value: "revenue" },
      properties: { unit: "currency:EUR", cellDisplay: "gauge", max: 3000, displayName: "Revenue" },
    },
    {
      matcher: { type: "name", value: "last_status" },
      properties: {
        cellDisplay: "color-background",
        displayName: "Last order",
        mappings: [{ type: "value", value: "paid", text: "Paid", tone: "ok" }],
      },
    },
  ],
};

async function openAll(user: ReturnType<typeof userEvent.setup>) {
  for (const summary of screen.getAllByText(/.+/, { selector: "summary" })) {
    await user.click(summary);
  }
}

describe("imported field options in the editor", () => {
  it("shows every imported option, none hidden", async () => {
    const user = userEvent.setup();
    render(<FieldConfigEditor value={IMPORTED_TABLE} groups={TABLE} onChange={() => {}} />);
    await openAll(user);
    const overrides = screen
      .getAllByRole("listitem")
      .filter((li) => li.classList.contains("viz-editor__override"));
    expect(overrides).toHaveLength(2);
    const [revenue, status] = overrides as [HTMLElement, HTMLElement];
    expect(within(revenue).getByRole("textbox", { name: "Name or pattern" })).toHaveProperty(
      "value",
      "revenue",
    );
    expect(shown(within(revenue).getByRole("combobox", { name: "Unit" }))).toContain("(EUR)");
    expect(within(revenue).getByRole("textbox", { name: "Display name" })).toHaveProperty(
      "value",
      "Revenue",
    );
    expect(shown(within(revenue).getByRole("combobox", { name: "Cell display" }))).toBe("Gauge");
    expect(within(revenue).getByRole("spinbutton", { name: "Max" })).toHaveProperty(
      "value",
      "3000",
    );
    expect(shown(within(status).getByRole("combobox", { name: "Cell display" }))).toBe(
      "Colored background",
    );
    expect(within(status).getByRole("textbox", { name: "Show as" })).toHaveProperty(
      "value",
      "Paid",
    );
  });

  it("names a stored unit it does not know instead of showing it as automatic", async () => {
    const user = userEvent.setup();
    render(
      <FieldConfigEditor
        value={{ defaults: { unit: "currencyEUR" }, overrides: [] }}
        groups={TABLE}
        onChange={() => {}}
      />,
    );
    await openAll(user);
    const unit = screen.getByRole("combobox", { name: "Unit" });
    expect(shown(unit)).toBe("Unknown unit: currencyEUR (not shown)");
    expect(shown(unit)).not.toContain("From the data source");
  });
});
