import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeForge, type PullRequest } from "../src/lib/forge.ts";
import {
  addReleaseNote,
  bullet,
  emptyNotes,
  insertNote,
  notesTarget,
} from "../src/lib/releases.ts";
import { tempTree } from "./helpers.ts";

const NOTES = `# Kalzit 0.5.0

## Improved

- Single sign-on.

## Fixed

- A crash.

## Checklist for Windows (manual)

- Install it.
`;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function repo(files: Record<string, string>) {
  const tree = tempTree(files);
  cleanup = tree.done;
  return tree.dir;
}

const releases = {
  "docs/releases/v0.4.2.md": "# Kalzit 0.4.2\n",
  "docs/releases/v0.4.10.md": "# Kalzit 0.4.10\n",
  "docs/releases/v0.5.0.md": NOTES,
};

function pr(number: number, headRefName: string, files: string[]): PullRequest {
  return { number, title: headRefName, headRefName, headRefOid: "", files };
}

describe("release file detection", () => {
  it("picks the newest notes file without a tag or release, comparing versions as numbers", () => {
    const root = repo(releases);
    const target = notesTarget(root, fakeForge({ tags: () => ["v0.4.2", "v0.4.10"] }));
    expect(target.file).toBe("docs/releases/v0.5.0.md");
    expect(target.exists).toBe(true);
    expect(target.released).toEqual(["0.4.10", "0.4.2"]);
  });

  it("moves to the next minor version once the newest is tagged or released on GitHub", () => {
    const root = repo(releases);
    const byTag = notesTarget(root, fakeForge({ tags: () => ["v0.5.0"] }));
    expect(byTag.file).toBe("docs/releases/v0.6.0.md");
    expect(byTag.exists).toBe(false);
    const byRelease = notesTarget(root, fakeForge({ releaseTags: () => ["v0.5.0"] }));
    expect(byRelease.file).toBe("docs/releases/v0.6.0.md");
  });

  it("treats a release pull request, open or merged before its tag, as closing the version", () => {
    const root = repo(releases);
    const open = notesTarget(
      root,
      fakeForge({ openPullRequests: () => [pr(182, "release/v0.5.0", [])] }),
    );
    expect(open.version).toBe("0.6.0");
    const merged = notesTarget(
      root,
      fakeForge({
        mergedPullRequests: () => [{ number: 182, headRefName: "release/v0.5.0", headRefOid: "" }],
      }),
    );
    expect(merged.version).toBe("0.6.0");
  });

  it("names other open pull requests that create the same file", () => {
    const root = repo(releases);
    const forge = fakeForge({
      tags: () => ["v0.5.0"],
      currentBranch: () => "feat/mine",
      openPullRequests: () => [
        pr(178, "m6/collation", ["docs/releases/v0.6.0.md"]),
        pr(179, "feat/mine", ["docs/releases/v0.6.0.md"]),
        pr(181, "ux/ui-fixer-3", ["ui/src/app.tsx"]),
      ],
    });
    const target = notesTarget(root, forge);
    expect(target.othersCreating.map((p) => p.number)).toEqual([178]);
  });

  it("does not warn once the file is on main", () => {
    const root = repo(releases);
    const forge = fakeForge({
      tags: () => ["v0.5.0"],
      mainFiles: () => ["v0.6.0.md"],
      openPullRequests: () => [pr(178, "m6/collation", ["docs/releases/v0.6.0.md"])],
    });
    expect(notesTarget(root, forge).othersCreating).toEqual([]);
  });

  it("refuses to add to a released version on request", () => {
    const root = repo(releases);
    expect(() =>
      notesTarget(root, fakeForge({ tags: () => ["v0.5.0"] }), { version: "0.5.0" }),
    ).toThrow(/released already/);
  });

  it("counts main's notes files, so an old branch never writes into released notes", () => {
    const root = repo(releases);
    const forge = fakeForge({
      tags: () => ["v0.5.0"],
      mainFiles: () => ["v0.5.0.md", "v0.6.0.md"],
    });
    const target = notesTarget(root, forge);
    expect(target.file).toBe("docs/releases/v0.6.0.md");
    expect(target.exists).toBe(false);
    expect(() => addReleaseNote(root, forge, { section: "fixed", text: "A fix." })).toThrow(
      /merge origin\/main first/,
    );
  });

  it("steps forward past every released version", () => {
    const root = repo(releases);
    const target = notesTarget(root, fakeForge({ tags: () => ["v0.5.0", "v0.6.0", "v0.7.0"] }));
    expect(target.version).toBe("0.8.0");
  });
});

describe("adding a note", () => {
  it("appends to the end of its section and keeps the other sections", () => {
    const out = insertNote(NOTES, "fixed", "Sorting follows the language.");
    expect(out).toContain(
      "## Fixed\n\n- A crash.\n- Sorting follows the language.\n\n## Checklist",
    );
    expect(out.endsWith("- Install it.\n")).toBe(true);
  });

  it("fills an empty section of a new file", () => {
    const out = insertNote(emptyNotes("0.6.0"), "improved", "New thing.");
    expect(out).toBe(
      "# Kalzit 0.6.0\n\n## Improved\n\n- New thing.\n\n## Fixed\n\n## Checklist for Windows (manual)\n",
    );
    const last = insertNote(out, "windows", "Check it on Windows.");
    expect(last.endsWith("## Checklist for Windows (manual)\n\n- Check it on Windows.\n")).toBe(
      true,
    );
  });

  it("adds a missing section in its place", () => {
    const out = insertNote(
      "# Kalzit 0.6.0\n\n## Improved\n\n- A.\n\n## Checklist for Windows (manual)\n\n- B.\n",
      "fixed",
      "C.",
    );
    expect(out).toBe(
      "# Kalzit 0.6.0\n\n## Improved\n\n- A.\n\n## Fixed\n\n- C.\n\n## Checklist for Windows (manual)\n\n- B.\n",
    );
  });

  it("wraps at 100 columns with a hanging indent", () => {
    const lines = bullet(`${"word ".repeat(40)}end`);
    expect(lines.every((line) => line.length <= 100)).toBe(true);
    expect(lines[0]?.startsWith("- word")).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true);
  });

  it("creates the next file with the three sections and warns about another creator", () => {
    const root = repo(releases);
    const forge = fakeForge({
      tags: () => ["v0.5.0"],
      openPullRequests: () => [pr(178, "m6/collation", ["docs/releases/v0.6.0.md"])],
    });
    const result = addReleaseNote(root, forge, {
      section: "fixed",
      text: "- Sorting follows the language.",
    });
    expect(result.created).toBe(true);
    expect(result.warnings.join()).toContain("#178");
    const text = readFileSync(join(root, "docs/releases/v0.6.0.md"), "utf8");
    expect(text).toContain("## Fixed\n\n- Sorting follows the language.\n");
    expect(readFileSync(join(root, "docs/releases/v0.5.0.md"), "utf8")).toBe(NOTES);
  });
});
