import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { catalogs, type MessageKey } from "../../i18n/i18n";
import {
  KIND_FAMILIES,
  KIND_LOGOS,
  KindLabel,
  KindMark,
  kindFamily,
  kindLogos,
  kindSummary,
  LOGO_PATHS,
} from "./kindMarks";

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
    expect(container.querySelector(".kind-logo")?.getAttribute("data-logo")).toBe("mongodb");
    expect(container.textContent).toBe("MongoDB");
  });

  it("bundles one path per logo and maps every logo kind to bundled logos", () => {
    for (const [name, path] of Object.entries(LOGO_PATHS)) {
      expect(path.length, name).toBeGreaterThan(20);
    }
    for (const logos of Object.values(KIND_LOGOS)) {
      for (const logo of logos) {
        expect(Object.hasOwn(LOGO_PATHS, logo), logo).toBe(true);
      }
    }
    // Two products behind one kind show both marks.
    expect(kindLogos("mysql")).toEqual(["mysql", "mariadb"]);
  });

  it("fills logos with the current color, which the stylesheet sets per brand", () => {
    const { container } = render(<KindMark kind="postgres" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("data-logo")).toBe("postgresql");
  });

  it("keeps the line glyph in the current color where there is no logo", () => {
    for (const kind of ["mssql", "file", "http_json", "memgraph", "something-new"]) {
      const { container, unmount } = render(<KindMark kind={kind} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("stroke"), kind).toBe("currentColor");
      expect(svg?.getAttribute("fill"), kind).toBe("none");
      expect(container.querySelector(".kind-mark")?.getAttribute("data-family"), kind).toBe(
        kindFamily(kind),
      );
      unmount();
    }
  });
});
