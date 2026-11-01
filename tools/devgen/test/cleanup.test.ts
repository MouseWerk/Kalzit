import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupStorage,
  DEFAULT_IDLE_HOURS,
  decide,
  parseWorktrees,
  type WorktreeFacts,
} from "../src/lib/cleanup.ts";
import { fakeForge } from "../src/lib/forge.ts";
import { tempTree } from "./helpers.ts";

const finished: WorktreeFacts = {
  mergedPr: 180,
  ownCommits: true,
  ownCommitsInMain: false,
  locked: false,
  clean: true,
  idleHours: 30,
};

describe("which worktrees count as finished", () => {
  it("removes a squash-merged, clean, unlocked and idle worktree", () => {
    expect(decide(finished, DEFAULT_IDLE_HOURS)).toEqual({
      merged: true,
      removable: true,
      note: "merged as #180",
    });
  });

  it("counts a branch whose own commits are all in origin/main", () => {
    const facts = { ...finished, ownCommitsInMain: true };
    delete facts.mergedPr;
    expect(decide(facts, 2).removable).toBe(true);
  });

  it("keeps a fresh worktree on a main commit: an agent's new isolation worktree", () => {
    const fresh: WorktreeFacts = {
      ownCommits: false,
      ownCommitsInMain: false,
      locked: false,
      clean: true,
      idleHours: 50,
    };
    const verdict = decide(fresh, 2);
    expect(verdict.removable).toBe(false);
    expect(verdict.merged).toBe(false);
    expect(verdict.note).toContain("no commits of its own");
  });

  it("keeps unmerged work, locked, changed and recently touched worktrees", () => {
    const unmerged = { ...finished };
    delete unmerged.mergedPr;
    expect(decide(unmerged, 2).removable).toBe(false);
    expect(decide({ ...finished, locked: true }, 2).note).toContain("locked");
    expect(decide({ ...finished, clean: false }, 2).note).toContain("uncommitted");
    const busy = decide({ ...finished, idleHours: 0.5 }, 2);
    expect(busy.removable).toBe(false);
    expect(busy.note).toContain("changed 0.5 h ago");
  });

  it("reads locked worktrees from git's porcelain list", () => {
    const list = [
      "worktree F:/repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree F:/repo/.claude/worktrees/agent-1",
      "HEAD def",
      "branch refs/heads/feat/x",
      "locked claude agent agent-1 (pid 123)",
      "",
    ].join("\n");
    expect(parseWorktrees(list)).toEqual([
      { path: "F:/repo", head: "abc", branch: "main", locked: false },
      { path: "F:/repo/.claude/worktrees/agent-1", head: "def", branch: "feat/x", locked: true },
    ]);
  });
});

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("cargo target dirs", () => {
  it("removes only idle <home>/kalzit-target-* dirs, never links or other folders", () => {
    const tree = tempTree({
      "repo/README.md": "x\n",
      "home/kalzit-target-old/debug/a.rlib": "x".repeat(100),
      "home/kalzit-target-busy/debug/b.rlib": "y",
      "home/other-target/c": "z",
      "elsewhere/keep/d": "w",
    });
    cleanup = tree.done;
    execFileSync("git", ["init", "-q"], { cwd: join(tree.dir, "repo") });
    const now = Date.now();
    const old = (now - 10 * 3_600_000) / 1000;
    for (const path of [
      "home/kalzit-target-old",
      "home/kalzit-target-old/debug",
      "home/kalzit-target-old/debug/a.rlib",
    ]) {
      utimesSync(join(tree.dir, path), old, old);
    }
    // A junction (Windows) or symlink with the prefix, pointing at a folder that must survive.
    const link = join(tree.dir, "home", "kalzit-target-link");
    symlinkSync(join(tree.dir, "elsewhere"), link, "junction");
    utimesSync(join(tree.dir, "elsewhere/keep/d"), old, old);
    mkdirSync(join(tree.dir, "home", "kalzit-target-empty-file-parent"), { recursive: true });
    writeFileSync(join(tree.dir, "home", "kalzit-target-file"), "not a dir");

    const dry = cleanupStorage(join(tree.dir, "repo"), fakeForge(), {
      home: join(tree.dir, "home"),
      now,
      idleHours: 0,
    });
    // idleHours is clamped to at least 1: the busy dir (touched now) stays.
    expect(dry.idleHours).toBe(1);
    expect(dry.targets.map((t) => [t.path.split("/").pop(), t.removable]).sort()).toEqual([
      ["kalzit-target-busy", false],
      ["kalzit-target-empty-file-parent", false],
      ["kalzit-target-old", true],
    ]);
    expect(dry.reclaimable).toBe(100);

    cleanupStorage(join(tree.dir, "repo"), fakeForge(), {
      home: join(tree.dir, "home"),
      now,
      apply: true,
    });
    expect(existsSync(join(tree.dir, "home/kalzit-target-old"))).toBe(false);
    expect(existsSync(join(tree.dir, "home/kalzit-target-busy"))).toBe(true);
    expect(existsSync(join(tree.dir, "home/other-target/c"))).toBe(true);
    expect(existsSync(join(tree.dir, "elsewhere/keep/d"))).toBe(true);
  });
});
