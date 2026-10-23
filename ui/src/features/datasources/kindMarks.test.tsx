import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { catalogs, type MessageKey } from "../../i18n/i18n";
import { KIND_FAMILIES, KindLabel, KindMark, kindFamily, kindSummary } from "./kindMarks";

const t = (key: MessageKey) => catalogs.en[key];

describe("kind marks", () => {
  it("gives every known kind a family and an unknown one the generic glyph", () => {
    expect(kindFamily("postgres")).toBe("sql");
    expect(kindFamily("sqlite")).toBe("sqlFile");
    expect(kindFamily("prometheus")).toBe("metrics");
    expect(kindFamily("mongodb")).toBe("documents");
    expect(kindFamily("neo4j")).toBe("graph");
    expect(kindFamily("something-new")).toBe("generic");
    // Names from the object prototype are no kinds.
    expect(kindFamily("toString")).toBe("generic");
  });

  it("has a summary in both languages for each kind it knows a summary for", () => {
    for (const kind of Object.keys(KIND_FAMILIES)) {
      const key = `datasources.kinds.${kind}.summary`;
      expect(Object.hasOwn(catalogs.de, key), key).toBe(Object.hasOwn(catalogs.en, key));
    }
    expect(kindSummary(t as never, "postgres")).toBe(
      catalogs.en["datasources.kinds.postgres.summary"],
    );
    expect(kindSummary(t as never, "something-new")).toBeNull();
  });

  it("draws a decorative mark next to the name, which carries the meaning", () => {
    const { container } = render(<KindLabel kind="mongodb" name="MongoDB" />);
    const mark = container.querySelector(".kind-mark");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.getAttribute("data-family")).toBe("documents");
    expect(container.textContent).toBe("MongoDB");
  });

  it("draws in the current color only, so it follows every theme", () => {
    const { container } = render(<KindMark kind="postgres" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.getAttribute("fill")).toBe("none");
  });
});
