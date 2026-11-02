import { describe, expect, it } from "vitest";
import { fakeForge, type PullRequest } from "../src/lib/forge.ts";
import { prOverlap } from "../src/lib/overlap.ts";

function pr(number: number, headRefName: string, files: string[]): PullRequest {
  return { number, title: headRefName, headRefName, headRefOid: "", files };
}

const open = [
  pr(178, "m6/collation", [
    "server/migrations/0035_sort_keys.sql",
    "docs/releases/v0.6.0.md",
    "server/src/routes/plugins.rs",
  ]),
  pr(181, "ux/ui-fixer-3", [
    "docs/releases/v0.6.0.md",
    "server/src/routes/plugins.rs",
    "ui/src/app.tsx",
  ]),
  pr(183, "feat/dev-toolkit", ["server/migrations/0035_tool.sql", "tools/devkit/README.md"]),
];

describe("pr_overlap", () => {
  it("lists files several open pull requests change, likely conflicts first", () => {
    const report = prOverlap(fakeForge({ openPullRequests: () => open }));
    expect(report.shared.map((s) => [s.file, s.likelyConflict, s.by])).toEqual([
      ["docs/releases/v0.6.0.md", true, ["#178 m6/collation", "#181 ux/ui-fixer-3"]],
      ["server/src/routes/plugins.rs", false, ["#178 m6/collation", "#181 ux/ui-fixer-3"]],
    ]);
    expect(report.migrationClashes).toEqual([
      {
        number: "0035",
        files: ["0035_sort_keys.sql (#178 m6/collation)", "0035_tool.sql (#183 feat/dev-toolkit)"],
      },
    ]);
  });

  it("compares one branch without a pull request against the open ones", () => {
    const forge = fakeForge({
      openPullRequests: () => open,
      branchFiles: () => ["ui/src/app.tsx", "README.md"],
    });
    const report = prOverlap(forge, { branch: "feat/new" });
    expect(report.subject).toBe("feat/new");
    expect(report.shared).toEqual([
      {
        file: "ui/src/app.tsx",
        by: ["#181 ux/ui-fixer-3", "feat/new"],
        hint: "same file: read both diffs before merging",
        likelyConflict: false,
      },
    ]);
    expect(report.migrationClashes).toEqual([]);
  });

  it("answers for one open pull request by number", () => {
    const report = prOverlap(fakeForge({ openPullRequests: () => open }), { pr: 183 });
    expect(report.shared).toEqual([]);
    expect(report.migrationClashes[0]?.number).toBe("0035");
  });
});
