import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildNotices,
  fromCargoMetadata,
  fromPackageLock,
  isStrict,
  merge,
  SEE_FILE,
} from "../../../scripts/licenses.mjs";
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
    await openAdmin("/settings/about", { isServerAdmin: true });
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
      within(company)
        .getByRole("link", { name: new RegExp(`^${name}`) })
        .getAttribute("href") ?? "";
    expect(href("GitHub repository")).toBe("https://github.com/MouseWerk/Kalzit");
    expect(href("Website")).toBe("https://kalzit.dev");
    expect(href("Security policy")).toBe(
      "https://github.com/MouseWerk/Kalzit/blob/main/SECURITY.md",
    );

    const license = screen.getByRole("region", { name: "License" });
    expect(within(license).getByText("GNU Affero General Public License v3.0")).toBeTruthy();
    expect(within(license).getByRole("link", { name: /^Source code/ })).toBeTruthy();
    expect(within(license).getByRole("link", { name: /^Full license text/ })).toBeTruthy();
    expect(
      within(license).getByText(
        "Independently developed, without code from other dashboard products.",
      ),
    ).toBeTruthy();
  });

  it("shows members the version and build date only", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await openAdmin("/settings/about", { isServerAdmin: false, permissions: [] });
    await section();
    const product = await screen.findByRole("region", { name: "Product" });
    expect(await within(product).findByText("0.1.0")).toBeTruthy();
    expect(within(product).getByText("2026-10-25")).toBeTruthy();
    for (const hidden of ["Commit", "Platform", "Database"]) {
      expect(within(product).queryByText(hidden), hidden).toBeNull();
    }
  });

  it("marks links that open a new tab for assistive technology", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await openAdmin("/settings/about", { isServerAdmin: false, permissions: [] });
    await section();
    const link = screen.getByRole("link", { name: /^GitHub repository/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.textContent).toContain("opens in a new tab");
  });

  it("links the full license texts and explains the license of a crate with a file", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await openAdmin("/settings/about", { isServerAdmin: false, permissions: [] });
    await section();
    const notices = await screen.findByRole("link", {
      name: /^Full license texts of these packages/,
    });
    expect(notices.getAttribute("href")).toBe("/THIRD-PARTY-NOTICES.txt");
  });

  it("says so when the build wrote no license list", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { user, server } = await openAdmin("/settings/profile", {
      isServerAdmin: false,
      permissions: [],
    });
    server.failNext("/third-party-licenses.json", 404, "not_found");
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    await user.click(within(nav).getByRole("link", { name: "About Kalzit" }));
    expect(
      await screen.findByText(/The list of third-party licenses is created when Kalzit is built/),
    ).toBeTruthy();
    expect(screen.queryByRole("searchbox", { name: "Search packages" })).toBeNull();
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

  it("keeps the path of a package out of its entry and names a crate with a license file", () => {
    const crates = fromCargoMetadata({
      ...metadata,
      packages: metadata.packages.map((pkg) =>
        pkg.name === "axum"
          ? { ...pkg, license: null, manifest_path: "/registry/axum-0.8.9/Cargo.toml" }
          : pkg,
      ),
    });
    const axum = crates.find((crate) => crate.name === "axum");
    expect(axum?.license).toBe(SEE_FILE);
    expect(Object.keys(axum ?? {})).toEqual(["name", "version", "license", "source"]);
    expect(JSON.stringify(crates)).not.toContain("registry");
  });

  it("collects each distinct license text once with the packages that ship it", () => {
    const root = mkdtempSync(join(tmpdir(), "kalzit-notices-"));
    const entry = (name: string, text?: string) => {
      const dir = join(root, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      if (text !== undefined) {
        writeFileSync(join(dir, "LICENSE-MIT"), text);
      }
      return fromPackageLock(
        { packages: { [`node_modules/${name}`]: { version: "1.0.0", license: "MIT" } } },
        root,
      )[0];
    };
    const license = (holder: string) => ["MIT License", "", `Copyright (c) ${holder}`].join("\n");
    const notices = buildNotices([
      entry("alpha", license("A")),
      entry("beta", license("A")),
      entry("gamma", license("C")),
      entry("delta"),
    ] as never);
    expect(notices.match(/Copyright \(c\) A/g)).toHaveLength(1);
    expect(notices).toContain(["alpha 1.0.0 (npm, MIT)", "beta 1.0.0 (npm, MIT)"].join("\n"));
    expect(notices).toContain("Copyright (c) C");
    expect(notices).toContain("Packages that ship no license file");
    expect(notices).toContain("delta 1.0.0");
  });

  it("fails hard only where a release could be affected", () => {
    expect(isStrict({})).toBe(false);
    expect(isStrict({ CI: "true" })).toBe(true);
    expect(isStrict({ CI: "true", KALZIT_LICENSES_STRICT: "0" })).toBe(false);
    expect(isStrict({ KALZIT_LICENSES_STRICT: "1" })).toBe(true);
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
