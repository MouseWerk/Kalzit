import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCss, type StyleRule } from "../../test/cssParse";

/**
 * Layout defects of the alerting screens found in the UI pass of 2026-11 and fixed at their root,
 * kept as rules of the stylesheet so they do not come back.
 */

const RULES: StyleRule[] = parseCss(
  readFileSync(resolve(import.meta.dirname, "alerting.css"), "utf8"),
);

function value(selector: string, property: string, context?: RegExp): string[] {
  return RULES.filter((rule) =>
    rule.selector
      .split(/,(?![^()]*\))/)
      .map((part) => part.trim().replace(/\s+/g, " "))
      .includes(selector),
  )
    .filter((rule) =>
      context === undefined
        ? !rule.context.some((c) => c.startsWith("@container"))
        : rule.context.some((c) => context.test(c)),
    )
    .flatMap((rule) => rule.declarations)
    .filter((declaration) => declaration.property === property)
    .map((declaration) => declaration.value);
}

const MEDIUM = /@container alert-list \(width < 80rem\)/;
const TIGHT = /@container alert-list \(width < 56rem\)/;
const NARROW = /@container alert-list \(width < 40rem\)/;

describe("alerting layout guards", () => {
  it("keeps a list's frame from widening the page: it is a size container that scrolls", () => {
    expect(value(".alert-table-wrap", "container")).toEqual(["alert-list / inline-size"]);
    expect(value(".alert-table-wrap", "overflow-x")).toEqual(["auto"]);
    expect(value(".alert-ptree", "container")).toEqual(["alert-tree / inline-size"]);
  });

  it("folds source, shape and interval of a rule into two lines when the room is short", () => {
    // Wide: the board's columns, the folded lines hidden.
    expect(value(".alert-rules__fold", "display")).toEqual(["none"]);
    expect(value(".alert-rules__fold-tight", "display")).toEqual(["none"]);
    expect(value(".alert-rules__wide", "display")).toEqual([]);
    // Less room: the columns go, their values stand under the name and the condition.
    expect(value(".alert-rules__wide", "display", MEDIUM)).toEqual(["none"]);
    expect(value(".alert-rules__fold", "display", MEDIUM)).toEqual(["flex"]);
    // The folded line never widens the table: a long source name ends in an ellipsis.
    expect(value(".alert-rules__fold", "contain", MEDIUM)).toEqual(["inline-size"]);
    expect(value(".alert-rules__fold .alert-source__name", "text-overflow", MEDIUM)).toEqual([
      "ellipsis",
    ]);
    // With the least room for a table, the evaluation time moves under the state.
    expect(value(".alert-rules__roomy", "display", TIGHT)).toEqual(["none"]);
    expect(value(".alert-rules__fold-tight", "display", TIGHT)).toEqual(["block"]);
    // There cells stand closer and the condition takes that room: two lines, not a word per line.
    expect(value(".alert-rules :is(th, td)", "padding-inline", TIGHT)).toEqual(["var(--space-2)"]);
    expect(value(".alert-rules__condition", "min-width", TIGHT)).toEqual(["var(--size-card-min)"]);
    // The name and the condition keep a least width; state, interval and times stay on one line.
    expect(value(".alert-rules__name", "min-width")).toEqual(["var(--size-field)"]);
    expect(value(".alert-rules__condition", "min-width")).toEqual(["var(--size-label)"]);
    expect(value(".alert-nowrap", "white-space")).toEqual(["nowrap"]);
    expect(value(".alert-state", "white-space")).toEqual(["nowrap"]);
  });

  it("keeps room at 1024 px for a state line at its longest, whatever the clock says", () => {
    // Times and counts in the state and evaluation cells use figures of one width.
    expect(
      value(".alert-rules :is(.alert-table__lead, .alert-rules__roomy)", "font-variant-numeric"),
    ).toEqual(["tabular-nums"]);
    // With the least room the name's column gives a step of its least width.
    expect(value(".alert-rules__name", "min-width", TIGHT)).toEqual([
      "calc(var(--size-field) - var(--space-8))",
    ]);
  });

  it("stacks the rows of a list as cards on a phone, each value with its column's name", () => {
    expect(value(".alert-table--stack tr", "display", NARROW)).toEqual(["grid"]);
    expect(value(".alert-table--stack td", "grid-column", NARROW)).toEqual(["1 / -1"]);
    expect(value(".alert-table--stack td[data-label]::before", "content", NARROW)).toEqual([
      'attr(data-label) / ""',
    ]);
    // The header row stays for screen readers, out of sight.
    expect(value(".alert-table--stack thead", "clip-path", NARROW)).toEqual(["inset(50%)"]);
  });

  it("writes a policy's own values on one line that breaks only between two values", () => {
    expect(value(".alert-times", "flex-direction")).toEqual([]);
    expect(value(".alert-times", "flex-wrap")).toEqual(["wrap"]);
    expect(value(".alert-times__part", "white-space")).toEqual(["nowrap"]);
  });

  it("names a policy's times where the column's heading is hidden", () => {
    const narrow = /@container alert-tree \(width < 40rem\)/;
    expect(value(".alert-prow--head", "display", narrow)).toEqual(["none"]);
    expect(value(".alert-times__named", "display")).toEqual(["none"]);
    expect(value(".alert-times__bare", "display")).toEqual([]);
    // With a class more than the rule that hides it, which stands later in the sheet.
    expect(value(".alert-prow .alert-times__named", "display", narrow)).toEqual(["inline"]);
    expect(value(".alert-times__bare", "display", narrow)).toEqual(["none"]);
  });

  it("draws a segmented control as wide as its options, also in a column of fields", () => {
    expect(value(".alert-seg", "width")).toEqual(["fit-content"]);
    expect(value(".alert-seg", "max-width")).toEqual(["100%"]);
  });

  it("starts the editor's two columns on one line: the empty error region takes no gap", () => {
    expect(value(".alert-editor__form > .form-alert:empty", "margin-bottom")).toEqual([
      "calc(var(--space-4) * -1)",
    ]);
    // The same step as the column's own gap, which it takes back.
    expect(value(".alert-editor__form", "gap")).toEqual(["var(--space-4)"]);
  });

  it("leaves the gaps between the blocks of a list page to the page", () => {
    expect(
      value(
        ".page > :is(.alert-tabs, .alert-note, .alert-alarm, .alert-hint, .alert-toolbar, .alert-timeline)",
        "margin",
      ),
    ).toEqual(["0"]);
  });

  it("gives the small controls a pointer target of 24 px", () => {
    // The fold button of a policy row and the "active" switch row.
    expect(value(".alert-elbow", "width")).toEqual(["var(--space-6)"]);
    expect(value(".alert-switch-row", "min-height")).toEqual(["var(--control-height)"]);
  });
});
