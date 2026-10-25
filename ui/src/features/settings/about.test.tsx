import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fromCargoMetadata, fromPackageLock, merge } from "../../../scripts/licenses.mjs";
import { setLanguage } from "../../i18n/i18n";
import { openAdmin } from "../admin/test/openAdmin";
import { filterLicenses } from "./AboutSection";
import {
  crossing,
  EDGES,
  FACES,
  hull,
  phaseAt,
  project,
  SHAPE,
  STILL_PHASE,
  type Vec3,
} from "./crystal";
import { buildIndex, search } from "./search";
import { SECTIONS } from "./sections";

function section() {
  return screen.findByRole("heading", { level: 2, name: "About Kalzit" });
}

describe("settings, About", () => {
  it("is open to every member and sits at the bottom of the navigation", async () => {
    // jsdom has no canvas; the picture is decoration and must not be needed.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await openAdmin("/settings/about", { isServerAdmin: false, permissions: [] });
    await section();
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.at(-1)?.textContent).toBe("About Kalzit");
    expect(links.at(-1)?.getAttribute("aria-current")).toBe("page");
  });

  it("names the build the server reports, the company, the license and the clean-room note", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await openAdmin("/settings/about", { isServerAdmin: false, permissions: [] });
    await section();
    const product = await screen.findByRole("region", { name: "Product" });
    expect(await within(product).findByText("0.1.0")).toBeTruthy();
    expect(within(product).getByText("a1b2c3d4e")).toBeTruthy();
    expect(within(product).getByText("2026-10-25")).toBeTruthy();
    expect(within(product).getByText("Linux x64")).toBeTruthy();
    expect(within(product).getByText("SQLite")).toBeTruthy();
    expect(
      screen.getByText("Calcite, the sunstone that makes hidden structure visible."),
    ).toBeTruthy();

    const company = screen.getByRole("region", { name: "Company" });
    const href = (name: string) =>
      within(company).getByRole("link", { name }).getAttribute("href") ?? "";
    expect(href("GitHub repository")).toBe("https://github.com/MouseWerk/Kalzit");
    expect(href("Website")).toBe("https://kalzit.dev");
    expect(href("Security policy")).toBe(
      "https://github.com/MouseWerk/Kalzit/blob/main/SECURITY.md",
    );

    const license = screen.getByRole("region", { name: "License" });
    expect(within(license).getByText("GNU Affero General Public License v3.0")).toBeTruthy();
    expect(within(license).getByRole("link", { name: "Source code" })).toBeTruthy();
    expect(within(license).getByRole("link", { name: "Full license text" })).toBeTruthy();
    expect(
      within(license).getByText(
        "Independently developed, without code from other dashboard products.",
      ),
    ).toBeTruthy();
  });

  it("lists the third-party packages and filters them by name or license", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { user } = await openAdmin("/settings/about", { isServerAdmin: false, permissions: [] });
    await section();
    const list = await screen.findByRole("region", { name: "Third-party packages" });
    expect(within(list).getByRole("rowheader", { name: "axum" })).toBeTruthy();
    expect(within(list).getByRole("rowheader", { name: "react" })).toBeTruthy();
    expect(screen.getByText("3 of 3 packages")).toBeTruthy();

    await user.type(screen.getByRole("searchbox", { name: "Search packages" }), "apache");
    expect(within(list).getByRole("rowheader", { name: "sqlx" })).toBeTruthy();
    expect(within(list).queryByRole("rowheader", { name: "axum" })).toBeNull();
    expect(screen.getByText("1 of 3 packages")).toBeTruthy();
  });

  it("speaks German with du", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await openAdmin("/settings/about", { isServerAdmin: false, permissions: [] });
    await section();
    act(() => setLanguage("de"));
    expect(await screen.findByRole("heading", { level: 2, name: "Über Kalzit" })).toBeTruthy();
    expect(
      await screen.findByText("Eigenständig entwickelt, ohne Code anderer Dashboard-Produkte."),
    ).toBeTruthy();
  });

  it("draws the crystal as decoration, hidden from assistive technology", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await openAdmin("/settings/about", { isServerAdmin: false, permissions: [] });
    await section();
    const canvas = document.querySelector("canvas");
    expect(canvas?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("is found by the settings search", async () => {
    const access = {
      permissions: { isServerAdmin: false, has: () => false } as never,
      orgId: undefined,
    };
    const results = search(buildIndex(SECTIONS, access), "lizenz");
    expect(results.some((entry) => entry.sectionId === "about")).toBe(true);
    expect(search(buildIndex(SECTIONS, access), "agpl")[0]?.sectionId).toBe("about");
  });
});

describe("third-party license list", () => {
  const metadata = {
    workspace_members: ["kalzit 0.1.0", "kalzit-release 0.1.0"],
    packages: [
      { id: "kalzit 0.1.0", name: "kalzit", version: "0.1.0", license: "AGPL-3.0-only" },
      { id: "kalzit-release 0.1.0", name: "kalzit-release", version: "0.1.0", license: null },
      { id: "axum 0.8.9", name: "axum", version: "0.8.9", license: "MIT" },
      { id: "tower 0.5.2", name: "tower", version: "0.5.2", license: "MIT" },
      { id: "tempfile 3.0.0", name: "tempfile", version: "3.0.0", license: "MIT OR Apache-2.0" },
      { id: "cc 1.0.0", name: "cc", version: "1.0.0", license: "MIT OR Apache-2.0" },
    ],
    resolve: {
      nodes: [
        {
          id: "kalzit 0.1.0",
          deps: [
            { pkg: "axum 0.8.9", dep_kinds: [{ kind: null }] },
            { pkg: "tempfile 3.0.0", dep_kinds: [{ kind: "dev" }] },
            { pkg: "cc 1.0.0", dep_kinds: [{ kind: "build" }] },
          ],
        },
        { id: "axum 0.8.9", deps: [{ pkg: "tower 0.5.2", dep_kinds: [{ kind: null }] }] },
        { id: "tower 0.5.2", deps: [] },
        { id: "tempfile 3.0.0", deps: [] },
        { id: "cc 1.0.0", deps: [] },
      ],
    },
  };

  it("takes the crates the binary links, not the workspace, tests or build tools", () => {
    const crates = fromCargoMetadata(metadata);
    expect(crates.map((crate) => crate.name).sort()).toEqual(["axum", "tower"]);
    expect(crates.find((crate) => crate.name === "axum")).toEqual({
      name: "axum",
      version: "0.8.9",
      license: "MIT",
      source: "rust",
    });
  });

  it("takes the npm packages of the lock file that are not dev-only", () => {
    const lock = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../package-lock.json"), "utf8"),
    );
    const packages = fromPackageLock(lock);
    expect(packages.length).toBeGreaterThan(10);
    const react = packages.find((entry) => entry.name === "react");
    expect(react?.license).toBe("MIT");
    expect(react?.source).toBe("npm");
    expect(packages.some((entry) => entry.name === "vitest")).toBe(false);
    expect(packages.every((entry) => entry.version !== "unknown" && entry.license !== "")).toBe(
      true,
    );
  });

  it("merges both lists sorted by name without duplicates", () => {
    const merged = merge(fromCargoMetadata(metadata), [
      { name: "react", version: "19.3.1", license: "MIT", source: "npm" },
      { name: "axum", version: "0.8.9", license: "MIT", source: "rust" },
    ]);
    expect(merged.map((entry) => entry.name)).toEqual(["axum", "react", "tower"]);
  });

  it("filters by every word, in name, version or license", () => {
    const entries = merge(fromCargoMetadata(metadata));
    expect(filterLicenses(entries, "").length).toBe(2);
    expect(filterLicenses(entries, "AXUM mit").map((entry) => entry.name)).toEqual(["axum"]);
    expect(filterLicenses(entries, "gpl")).toEqual([]);
  });
});

describe("calcite crystal", () => {
  const shape = project(0, 100, { x: 0, y: 0 });

  it("has the cleavage angle of calcite between the edges that meet at the long diagonal", () => {
    expect(FACES).toHaveLength(6);
    expect(EDGES).toHaveLength(12);
    const [origin, a, b] = [SHAPE[0], SHAPE[1], SHAPE[2]] as [Vec3, Vec3, Vec3];
    const edge = (to: Vec3): Vec3 => [to[0] - origin[0], to[1] - origin[1], to[2] - origin[2]];
    const [u, v] = [edge(a), edge(b)];
    const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const angle = (Math.acos(dot / (Math.hypot(...u) * Math.hypot(...v))) * 180) / Math.PI;
    expect(angle).toBeCloseTo(78.08, 1);
  });

  it("stands upright: its long diagonal is vertical", () => {
    const top = shape.points[7];
    const bottom = shape.points[0];
    expect(Math.abs((top?.x ?? 1) - (bottom?.x ?? 0))).toBeLessThan(1e-9);
    expect(Math.abs((top?.y ?? 0) - (bottom?.y ?? 0))).toBeGreaterThan(50);
  });

  it("finds where a horizontal beam enters and leaves", () => {
    const outline = hull(project(0.6, 100, { x: 200, y: 100 }).points);
    const span = crossing(outline, 100);
    expect(span).not.toBeNull();
    expect((span?.xIn ?? 0) < 200 && (span?.xOut ?? 0) > 200).toBe(true);
    expect(crossing(outline, 1000)).toBeNull();
  });

  it("splits the light and shows the structure at the still picture, and neither at the start", () => {
    const start = phaseAt(0);
    expect([start.travel, start.split, start.reveal]).toEqual([0, 0, 0]);
    const still = phaseAt(STILL_PHASE);
    expect(still.split).toBeGreaterThan(0.9);
    expect(still.reveal).toBeGreaterThan(0.9);
    const end = phaseAt(1);
    expect(end.light).toBe(0);
  });
});
