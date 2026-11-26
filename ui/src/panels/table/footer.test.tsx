import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Field, Frame } from "../../api/generated/shapes";
import type { FieldConfig } from "../fieldConfig/fieldConfig";
import { getPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import {
  calcFits,
  calcFor,
  calculate,
  EMPTY_FOOTER,
  parseFooter,
  parseFooterCalc,
  percentileOf,
} from "./footer";

const all = (n: number) => Uint32Array.from({ length: n }, (_, i) => i);
const field = (type: Field["type"], values: unknown[], name = "v"): Field => ({
  name,
  type,
  values,
});
const number = (calc: Parameters<typeof calculate>[0], values: unknown[]) => {
  const result = calculate(calc, field("number", values), all(values.length));
  return result.kind === "number" ? result.value : Number.NaN;
};
const cell = (calc: Parameters<typeof calculate>[0], values: unknown[]) => {
  const result = calculate(calc, field("number", values), all(values.length));
  return result.kind === "cell" ? result.raw : "not a cell";
};

describe("footer calculations", () => {
  it("use the shared names: first and last skip gaps, the row ones do not", () => {
    const values = [null, 2, 5, null];
    expect(cell("first", values)).toBe(2);
    expect(cell("last", values)).toBe(5);
    expect(cell("firstRow", values)).toBe(null);
    expect(cell("lastRow", values)).toBe(null);
    expect(cell("last", [null, null])).toBe(null);
  });

  it("sum, mean, min, max, range and the change leave gaps out", () => {
    const values = [4, null, 1, Number.NaN, 7];
    expect(number("sum", values)).toBe(12);
    expect(number("mean", values)).toBe(4);
    expect(number("min", values)).toBe(1);
    expect(number("max", values)).toBe(7);
    expect(number("range", values)).toBe(6);
    expect(number("delta", values)).toBe(3);
    expect(number("deltaPercent", values)).toBe(75);
    expect(number("deltaPercent", [0, 5])).toBeNaN();
    expect(number("sum", [null])).toBeNaN();
  });

  it("stddev and variance are the sample measures; percentiles interpolate", () => {
    expect(number("variance", [2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.571428, 5);
    expect(number("stddev", [2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 5);
    expect(number("stddev", [3])).toBeNaN();
    expect(number("median", [1, 2, 3, 4])).toBe(2.5);
    expect(
      number("p95", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
    ).toBe(20);
    expect(number("p50", [5, 1, 3])).toBe(3);
  });

  it("count, distinct values and gaps work on any column", () => {
    const names = field("string", ["a", null, "b", "a"]);
    const rows = all(4);
    expect(calculate("count", names, rows)).toEqual({ kind: "number", value: 3 });
    expect(calculate("gaps", names, rows)).toEqual({ kind: "number", value: 1 });
    expect(calculate("distinct", names, rows)).toEqual({ kind: "number", value: 2 });
  });

  it("int64 and decimal cells read as numbers", () => {
    const big = field("int64", ["9007199254740993", "-3", null]);
    expect(calculate("max", big, all(3))).toEqual({ kind: "number", value: 9007199254740992 });
    expect(calculate("sum", field("decimal", ["1.5", "2.25"]), all(2))).toEqual({
      kind: "number",
      value: 3.75,
    });
  });

  it("only read the rows given, in their order", () => {
    const values = field("number", [10, 20, 30, 40]);
    expect(calculate("sum", values, Uint32Array.from([3, 1]))).toEqual({
      kind: "number",
      value: 60,
    });
    expect(calculate("firstRow", values, Uint32Array.from([3, 1]))).toEqual({
      kind: "cell",
      raw: 40,
    });
  });
});

describe("stored footers", () => {
  it("keep known calculations, each column once, and read stdDev as stddev", () => {
    expect(parseFooter(undefined)).toEqual(EMPTY_FOOTER);
    expect(
      parseFooter({
        show: true,
        over: "filtered",
        numbers: "stdDev",
        columns: [
          { column: "Umsatz", calc: "p95" },
          { column: "Umsatz", calc: "max" },
          { column: "Land", calc: "average" },
          { column: "", calc: "sum" },
          { column: "Kunde", calc: "count" },
        ],
      }),
    ).toEqual({
      show: true,
      over: "filtered",
      numbers: "stddev",
      columns: [
        { column: "Umsatz", calc: "p95" },
        { column: "Kunde", calc: "count" },
      ],
    });
    expect(parseFooter({ over: "visible" }).over).toBe("all");
  });

  it("know percentiles from p1 to p99 only", () => {
    expect(percentileOf("p1")).toBe(1);
    expect(percentileOf("p99")).toBe(99);
    for (const text of ["p0", "p100", "p05", "p", "p9x"]) {
      expect(parseFooterCalc(text), text).toBeNull();
    }
  });

  it("pick a column's own calculation, else the number columns' one", () => {
    const footer = parseFooter({
      show: true,
      numbers: "sum",
      columns: [
        { column: "Kunde", calc: "count" },
        { column: "Land", calc: "mean" },
      ],
    });
    expect(calcFor(footer, field("string", [], "customer"), "Kunde")).toBe("count");
    expect(calcFor(footer, field("number", [], "amount"), "Umsatz")).toBe("sum");
    expect(calcFor(footer, field("string", [], "country"), "Land")).toBeUndefined();
    expect(calcFor(footer, field("string", [], "note"), "Notiz")).toBeUndefined();
    expect(calcFits("mean", "string")).toBe(false);
    expect(calcFits("lastRow", "string")).toBe(true);
  });
});

const frame: Frame = {
  fields: [
    { name: "Kunde", type: "string", values: ["Aurora", "Bergwerk", "Calcit", "Dolomit"] },
    { name: "Umsatz", type: "number", values: [48215, 31940, 27108, 9870] },
    { name: "Bestellungen", type: "int64", values: ["312", "204", "188", "71"] },
  ],
};

function renderTable(options: unknown, fieldConfig?: FieldConfig) {
  const plugin = getPanel("table") as AnyPanelPlugin;
  const { Panel } = plugin;
  return render(
    <div>
      <Panel
        frames={[frame]}
        options={plugin.options(options)}
        timeRange={{ from: 0, to: 1 }}
        title="Top-Kunden"
        {...(fieldConfig === undefined ? {} : { fieldConfig })}
      />
    </div>,
  );
}

describe("the table footer", () => {
  it("shows one calculation per column and says what it calculates over", () => {
    const { container } = renderTable({
      footer: {
        show: true,
        numbers: "sum",
        columns: [
          { column: "Kunde", calc: "count" },
          { column: "Bestellungen", calc: "mean" },
        ],
      },
    });
    const foot = container.querySelector("tfoot") as HTMLElement;
    const cells = within(foot).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual([
      "Count4 of 4 rows",
      "Total117,133",
      "Mean193.75",
    ]);
    expect(screen.getByText("Footer over all 4 rows")).toBeTruthy();
    expect(container.querySelector("table")?.getAttribute("aria-rowcount")).toBe("6");
  });

  it("over the filtered rows follows the column filters", () => {
    const { container } = renderTable({
      columnFilters: true,
      footer: { show: true, over: "filtered", numbers: "sum", columns: [] },
    });
    // No filter typed yet: all rows, and the note says so.
    expect(screen.getByText("Footer over all 4 rows")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter Umsatz"), { target: { value: ">30000" } });
    const foot = container.querySelector("tfoot") as HTMLElement;
    expect(within(foot).getAllByRole("cell")[1]?.textContent).toBe("Total80,155");
    expect(screen.getByText("Footer over the 2 filtered of 4 rows")).toBeTruthy();
  });

  it("shows the variance without the column's unit, which would be its square", () => {
    const { container } = renderTable(
      {
        footer: {
          show: true,
          columns: [
            { column: "Umsatz", calc: "variance" },
            { column: "Bestellungen", calc: "sum" },
          ],
        },
      },
      { defaults: { unit: "kg" }, overrides: [] },
    );
    const cells = within(container.querySelector("tfoot") as HTMLElement).getAllByRole("cell");
    expect(cells[1]?.textContent).toMatch(/^Variance[\d,.]+$/);
    // A sum keeps the unit.
    expect(cells[2]?.textContent).toContain("kg");
  });

  it("is absent while off", () => {
    const { container } = renderTable({ footer: { show: false, numbers: "sum" } });
    expect(container.querySelector("tfoot")).toBeNull();
  });
});
