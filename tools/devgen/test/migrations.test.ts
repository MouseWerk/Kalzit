import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeForge, type PullRequest } from "../src/lib/forge.ts";
import { checkMigrations, migrationName, nextMigration } from "../src/lib/migrations.ts";
import { tempTree } from "./helpers.ts";

const MAIN = Array.from(
  { length: 34 },
  (_, i) => `${String(i + 1).padStart(4, "0")}_m${i + 1}.sql`,
).filter(
  // Main has a gap, as the real history does (0012).
  (file) => !file.startsWith("0012"),
);

function pr(number: number, headRefName: string, files: string[]): PullRequest {
  return { number, title: headRefName, headRefName, headRefOid: "", files };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function checkout(files: string[] = MAIN) {
  const tree = tempTree(Object.fromEntries(files.map((f) => [`server/migrations/${f}`, "-- x\n"])));
  cleanup = tree.done;
  return tree.dir;
}

describe("next_migration", () => {
  it("counts main, this checkout and every open pull request", () => {
    const root = checkout();
    const forge = fakeForge({
      mainFiles: () => MAIN,
      currentBranch: () => "feat/mine",
      openPullRequests: () => [
        pr(173, "m5/scim", ["server/migrations/0035_scim.sql", "server/src/scim/mod.rs"]),
        pr(175, "m5/saml", ["server/migrations/0036_saml.sql"]),
      ],
    });
    const next = nextMigration(root, forge);
    expect(next.padded).toBe("0037");
    expect(next.newest[0]).toEqual({ number: 36, file: "0036_saml.sql", where: "#175 m5/saml" });
  });

  it("does not skip past a gap on main, only past the highest number", () => {
    const root = checkout();
    expect(nextMigration(root, fakeForge({ mainFiles: () => MAIN })).number).toBe(35);
  });

  it("counts this branch's own new file once, and not again through its own pull request", () => {
    const root = checkout([...MAIN, "0035_mine.sql"]);
    const forge = fakeForge({
      mainFiles: () => MAIN,
      currentBranch: () => "feat/mine",
      openPullRequests: () => [pr(180, "feat/mine", ["server/migrations/0035_mine.sql"])],
    });
    expect(nextMigration(root, forge).number).toBe(36);
  });

  it("creates the file with a header that names the portability rule", () => {
    const root = checkout();
    const result = nextMigration(root, fakeForge({ mainFiles: () => MAIN }), {
      name: "Sort keys",
      description: "Language-aware sort keys for names.",
      create: true,
    });
    expect(result.created).toBe("server/migrations/0035_sort_keys.sql");
    const text = readFileSync(join(root, "server/migrations/0035_sort_keys.sql"), "utf8");
    expect(text).toContain("-- Language-aware sort keys for names.");
    expect(text).toContain("SQLite and PostgreSQL");
    expect(existsSync(join(root, "server/migrations/0035_sort_keys.sql"))).toBe(true);
  });

  it("refuses a name without letters or digits", () => {
    expect(() => migrationName("---")).toThrow(/name/);
    expect(migrationName("Recent sign-ins")).toBe("recent_sign_ins");
  });
});

describe("check_migrations", () => {
  it("reports the clashes that happened twice: same number in two open pull requests", () => {
    const root = checkout();
    const forge = fakeForge({
      mainFiles: () => MAIN.filter((f) => !f.startsWith("0034")),
      branchFiles: (branch) =>
        branch === "m5/recent-sign-ins" ? ["server/migrations/0034_sign_ins.sql"] : [],
      openPullRequests: () => [
        pr(180, "m5/recent-sign-ins", ["server/migrations/0034_sign_ins.sql"]),
        pr(178, "m6/collation", ["server/migrations/0034_sort_keys.sql"]),
      ],
    });
    const result = checkMigrations(root, forge, "m5/recent-sign-ins");
    expect(result.added).toEqual(["0034_sign_ins.sql"]);
    expect(result.clashes).toHaveLength(1);
    expect(result.clashes[0]?.with).toEqual([
      { number: 34, file: "0034_sort_keys.sql", where: "#178 m6/collation" },
    ]);
  });

  it("reports a number main has taken meanwhile", () => {
    const root = checkout();
    const forge = fakeForge({
      mainFiles: () => MAIN,
      branchFiles: () => ["server/migrations/0034_mine.sql"],
    });
    const result = checkMigrations(root, forge, "feat/late");
    expect(result.clashes[0]?.with[0]?.where).toBe("main");
    expect(result.belowMain).toEqual(["0034_mine.sql"]);
  });

  it("is quiet for a branch with a free number", () => {
    const root = checkout();
    const forge = fakeForge({
      mainFiles: () => MAIN,
      branchFiles: () => ["server/migrations/0035_ok.sql"],
    });
    const result = checkMigrations(root, forge, "feat/ok");
    expect(result.clashes).toEqual([]);
    expect(result.belowMain).toEqual([]);
  });
});
