import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCss } from "../../test/cssParse";

/**
 * jsdom does no layout, so this checks the rules that keep a panel header usable at 360 px in
 * edit mode: four actions next to the title used to push past the panel's edge.
 */
const sheet = parseCss(readFileSync(resolve(import.meta.dirname, "dashboards.css"), "utf8"));
const declarations = (selector: string) =>
  sheet.find((rule) => rule.selector === selector)?.declarations ?? [];

describe("panel header on a narrow screen", () => {
  it("wraps the actions below the title instead of overflowing", () => {
    expect(declarations(".panel-card__header")).toContainEqual({
      property: "flex-wrap",
      value: "wrap",
    });
    const actions = declarations(".panel-card__actions");
    expect(actions).toContainEqual({ property: "flex-wrap", value: "wrap" });
    // `flex: none` kept the actions at full width however narrow the panel was.
    expect(actions).not.toContainEqual({ property: "flex", value: "none" });
    expect(actions).toContainEqual({ property: "min-width", value: "0" });
  });

  it("keeps the title at least a label wide, so it stays visible", () => {
    expect(declarations(".panel-card__title")).toContainEqual({
      property: "flex",
      value: "1 1 var(--size-label)",
    });
  });
});
