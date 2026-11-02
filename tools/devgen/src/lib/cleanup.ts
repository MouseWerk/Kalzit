import { lstatSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Forge } from "./forge.ts";
import { git, lines, slash } from "./repo.ts";

/**
 * Disk space taken by agent work: worktrees under .claude/worktrees and cargo target
 * directories (`kalzit-target-*` in the home folder). Lists them with their sizes; removes only
 * with `apply`, and only what is certainly finished:
 *
 * - a worktree whose work is merged: a merged pull request's head is exactly the worktree's
 *   commit (squash merges), or the branch has commits of its own and all are in origin/main;
 * - that has commits of its own (a fresh worktree on a main commit is someone's new isolation
 *   worktree, not finished work), is not locked, has no uncommitted or untracked changes, and
 *   whose HEAD, index and files did not change within the idle window;
 * - target directories nobody built in within the idle window.
 *
 * The main checkout and the checkout this runs in are never touched, and links or junctions are
 * never followed or removed.
 */

/** The shortest idle window: anything newer may belong to a running agent. */
export const MIN_IDLE_HOURS = 1;
export const DEFAULT_IDLE_HOURS = 2;
/** Target directories live here and only here: `<home>/kalzit-target-*`. */
export const TARGET_PREFIX = "kalzit-target-";

export interface WorktreeEntry {
  path: string;
  branch: string;
  head: string;
  bytes: number;
  merged: boolean;
  removable: boolean;
  /** Why it is kept, or how it counts as merged. */
  note: string;
  clean: boolean;
  /** Ignored entries (node_modules, build output) that go with the worktree. */
  ignored: number;
  idleHours: number;
  removed?: boolean;
}

export interface TargetEntry {
  path: string;
  bytes: number;
  idleHours: number;
  removable: boolean;
  removed?: boolean;
  note: string;
}

export interface CleanupReport {
  worktrees: WorktreeEntry[];
  targets: TargetEntry[];
  /** Bytes that `apply` frees (or freed). */
  reclaimable: number;
  applied: boolean;
  idleHours: number;
  warnings: string[];
}

/**
 * Bytes under a path and the newest modification time in it, without following links (a
 * junction must not count its target).
 */
export function scan(path: string): { bytes: number; newest: number } {
  let bytes = 0;
  let newest = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop() ?? "";
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(current);
      } catch {
        continue;
      }
      for (const name of names) {
        stack.push(join(current, name));
      }
    } else {
      bytes += stat.size;
    }
  }
  return { bytes, newest };
}

/** The newest modification time of files, or 0 for those that do not exist. */
function newestOf(paths: string[]): number {
  let newest = 0;
  for (const path of paths) {
    try {
      newest = Math.max(newest, lstatSync(path).mtimeMs);
    } catch {
      // Not there.
    }
  }
  return newest;
}

/** A real directory: not a link or junction (which `rmSync` must never be pointed at). */
function isPlainDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

interface Porcelain {
  path: string;
  head: string;
  branch: string;
  locked: boolean;
}

export function parseWorktrees(porcelain: string): Porcelain[] {
  const out: Porcelain[] = [];
  for (const block of porcelain.replace(/\r\n/g, "\n").split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path === undefined) {
      continue;
    }
    out.push({
      path: slash(path.trim()),
      head: /^HEAD (\w+)$/m.exec(block)?.[1] ?? "",
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "",
      locked: /^locked\b/m.test(block),
    });
  }
  return out;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** What is known about one worktree; `decide` turns it into keep or remove. */
export interface WorktreeFacts {
  /** A merged pull request whose head is exactly this commit. */
  mergedPr?: number;
  /** Commits of its own: not on main's first-parent line. */
  ownCommits: boolean;
  /** Every commit of its own is in origin/main. */
  ownCommitsInMain: boolean;
  locked: boolean;
  clean: boolean;
  idleHours: number;
}

export function decide(
  facts: WorktreeFacts,
  idleLimit: number,
): { merged: boolean; removable: boolean; note: string } {
  let merged = false;
  let note: string;
  if (facts.mergedPr !== undefined) {
    merged = true;
    note = `merged as #${facts.mergedPr}`;
  } else if (facts.ownCommits && facts.ownCommitsInMain) {
    merged = true;
    note = "its commits are in origin/main";
  } else if (!facts.ownCommits) {
    note = "no commits of its own (a new or running worktree): kept";
  } else {
    note = "not merged: kept";
  }
  const reasons: string[] = [];
  if (merged && facts.locked) {
    reasons.push("locked");
  }
  if (merged && !facts.clean) {
    reasons.push("uncommitted or untracked changes");
  }
  if (merged && facts.idleHours < idleLimit) {
    reasons.push(`changed ${facts.idleHours} h ago`);
  }
  if (reasons.length > 0) {
    note += `; ${reasons.join(", ")}: kept`;
  }
  return { merged, removable: merged && reasons.length === 0, note };
}

export function cleanupStorage(
  root: string,
  forge: Forge,
  options: { apply?: boolean; idleHours?: number; now?: number; home?: string } = {},
): CleanupReport {
  const warnings = [...forge.warnings];
  const apply = options.apply === true;
  const idleLimit = Math.max(MIN_IDLE_HOURS, options.idleHours ?? DEFAULT_IDLE_HOURS);
  const now = options.now ?? Date.now();
  const hours = (ms: number) => Math.round(((now - ms) / 3_600_000) * 10) / 10;
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const mainCheckout = slash(resolve(common.stdout.trim(), ".."));
  const here = slash(resolve(git(root, "rev-parse", "--show-toplevel").stdout.trim() || root));
  const worktreesDir = `${mainCheckout}/.claude/worktrees/`;
  const fetched = git(root, "fetch", "--quiet", "origin", "main");
  if (!fetched.ok) {
    warnings.push("git fetch origin main failed; merged state is as of the last fetch");
  }
  const merged = forge.mergedPullRequests();
  const mainLine = new Set(lines(git(root, "rev-list", "--first-parent", "origin/main").stdout));
  const worktrees: WorktreeEntry[] = [];
  const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (const wt of parseWorktrees(git(root, "worktree", "list", "--porcelain").stdout)) {
    if (
      samePath(wt.path, mainCheckout) ||
      !wt.path.toLowerCase().startsWith(worktreesDir.toLowerCase())
    ) {
      continue;
    }
    const present = isPlainDirectory(wt.path);
    const scanned = present ? scan(wt.path) : { bytes: 0, newest: 0 };
    const entry: WorktreeEntry = {
      path: wt.path,
      branch: wt.branch || "(detached)",
      head: wt.head.slice(0, 12),
      bytes: scanned.bytes,
      merged: false,
      removable: false,
      clean: false,
      ignored: 0,
      idleHours: 0,
      note: "",
    };
    if (samePath(wt.path, here)) {
      entry.note = "the checkout this runs in";
      worktrees.push(entry);
      continue;
    }
    if (!present) {
      entry.note = "missing or a link: kept (git worktree prune clears missing ones)";
      worktrees.push(entry);
      continue;
    }
    const status = git(wt.path, "status", "--porcelain", "--untracked-files=all", "--ignored");
    const statusLines = status.stdout.split("\n").filter((l) => l.trim() !== "");
    entry.clean = status.ok && statusLines.every((l) => l.startsWith("!! "));
    entry.ignored = statusLines.filter((l) => l.startsWith("!! ")).length;
    // HEAD and index of the worktree's own git dir, and every file in it.
    const gitDir = git(wt.path, "rev-parse", "--path-format=absolute", "--git-dir").stdout.trim();
    const touched = Math.max(
      scanned.newest,
      newestOf(gitDir === "" ? [] : [join(gitDir, "HEAD"), join(gitDir, "index")]),
    );
    entry.idleHours = hours(touched);
    const ownCommits = wt.head !== "" && !mainLine.has(wt.head);
    const ownCommitsInMain =
      ownCommits && git(root, "merge-base", "--is-ancestor", wt.head, "origin/main").ok;
    const pr = merged.find(
      (p) => wt.branch !== "" && p.headRefName === wt.branch && p.headRefOid === wt.head,
    );
    const verdict = decide(
      {
        ...(pr === undefined ? {} : { mergedPr: pr.number }),
        ownCommits,
        ownCommitsInMain,
        locked: wt.locked,
        clean: entry.clean,
        idleHours: entry.idleHours,
      },
      idleLimit,
    );
    Object.assign(entry, verdict);
    if (entry.removable && entry.ignored > 0) {
      entry.note += `; ${entry.ignored} ignored entries go with it`;
    }
    if (apply && entry.removable) {
      const removed = git(root, "worktree", "remove", wt.path);
      if (removed.ok) {
        entry.removed = true;
        // Merged as checked above; git refuses -d for a squash merge.
        if (wt.branch !== "") {
          git(root, "branch", "-D", wt.branch);
        }
      } else {
        warnings.push(`could not remove ${wt.path}: ${removed.stderr.trim()}`);
      }
    }
    worktrees.push(entry);
  }
  if (apply) {
    git(root, "worktree", "prune");
  }

  const home = options.home ?? homedir();
  const targets: TargetEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(home);
  } catch {
    warnings.push(`cannot read ${home}`);
  }
  for (const name of names) {
    const path = join(home, name);
    if (!name.startsWith(TARGET_PREFIX) || !isPlainDirectory(path)) {
      continue;
    }
    const scanned = scan(path);
    const idleHours = hours(scanned.newest);
    const removable = idleHours >= idleLimit;
    const entry: TargetEntry = {
      path: slash(path),
      bytes: scanned.bytes,
      idleHours,
      removable,
      note: removable ? `idle for ${idleLimit} h or more` : "built in recently: kept",
    };
    if (apply && removable && isPlainDirectory(path)) {
      rmSync(path, { recursive: true, force: true });
      entry.removed = true;
    }
    targets.push(entry);
  }
  const reclaimable =
    worktrees.filter((w) => w.removable).reduce((s, w) => s + w.bytes, 0) +
    targets.filter((t) => t.removable).reduce((s, t) => s + t.bytes, 0);
  return { worktrees, targets, reclaimable, applied: apply, idleHours: idleLimit, warnings };
}

export function worktreeLines(report: CleanupReport): string[] {
  return lines(
    report.worktrees
      .map(
        (w) =>
          `${w.removed === true ? "removed" : w.removable ? "removable" : "kept"}  ${formatBytes(w.bytes).padStart(10)}  ${w.branch}  ${w.path}  (${w.note})`,
      )
      .join("\n"),
  );
}
