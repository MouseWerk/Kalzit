import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Forge } from "./forge.ts";
import { git, lines, slash } from "./repo.ts";

/**
 * Disk space taken by agent work: worktrees under .claude/worktrees and cargo target
 * directories (`kalzit-target-*` in the home folder). Lists them with their sizes; removes only
 * with `apply`, and only what is safe: a worktree whose branch is merged into origin/main (also
 * as a squash merge: the merged pull request's head is the branch's commit) and has no
 * uncommitted changes, and target directories nobody built in for a while. The main checkout
 * and the checkout this runs in are never touched.
 */

export interface WorktreeEntry {
  path: string;
  branch: string;
  head: string;
  bytes: number;
  merged: boolean;
  /** Why it is kept, or how it counts as merged. */
  note: string;
  clean: boolean;
  removed?: boolean;
}

export interface TargetEntry {
  path: string;
  bytes: number;
  idleHours: number;
  removed?: boolean;
  note: string;
}

export interface CleanupReport {
  worktrees: WorktreeEntry[];
  targets: TargetEntry[];
  /** Bytes that `apply` frees (or freed). */
  reclaimable: number;
  applied: boolean;
  warnings: string[];
}

/** Bytes under a path, without following links (a junction must not count its target). */
export function sizeOf(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop() ?? "";
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
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
      total += stat.size;
    }
  }
  return total;
}

/** The newest modification time of a directory's top two levels, in ms. */
function lastTouched(path: string): number {
  let newest = statSync(path).mtimeMs;
  for (const name of readdirSync(path)) {
    try {
      const child = statSync(join(path, name));
      newest = Math.max(newest, child.mtimeMs);
      if (child.isDirectory()) {
        for (const inner of readdirSync(join(path, name))) {
          newest = Math.max(newest, statSync(join(path, name, inner)).mtimeMs);
        }
      }
    } catch {
      // A file removed while looking.
    }
  }
  return newest;
}

interface Porcelain {
  path: string;
  head: string;
  branch: string;
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

export function cleanupStorage(
  root: string,
  forge: Forge,
  options: { apply?: boolean; targetsGlob?: string; idleHours?: number; now?: number } = {},
): CleanupReport {
  const warnings = [...forge.warnings];
  const apply = options.apply === true;
  const idleLimit = options.idleHours ?? 2;
  const now = options.now ?? Date.now();
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const mainCheckout = slash(resolve(common.stdout.trim(), ".."));
  const here = slash(resolve(git(root, "rev-parse", "--show-toplevel").stdout.trim() || root));
  const worktreesDir = `${mainCheckout}/.claude/worktrees/`;
  const fetched = git(root, "fetch", "--quiet", "origin", "main");
  if (!fetched.ok) {
    warnings.push("git fetch origin main failed; merged state is as of the last fetch");
  }
  const merged = forge.mergedPullRequests();
  const worktrees: WorktreeEntry[] = [];
  for (const wt of parseWorktrees(git(root, "worktree", "list", "--porcelain").stdout)) {
    const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (
      samePath(wt.path, mainCheckout) ||
      !wt.path.toLowerCase().startsWith(worktreesDir.toLowerCase())
    ) {
      continue;
    }
    const entry: WorktreeEntry = {
      path: wt.path,
      branch: wt.branch || "(detached)",
      head: wt.head.slice(0, 12),
      bytes: existsSync(wt.path) ? sizeOf(wt.path) : 0,
      merged: false,
      clean: false,
      note: "",
    };
    if (samePath(wt.path, here)) {
      entry.note = "the checkout this runs in";
      worktrees.push(entry);
      continue;
    }
    const status = existsSync(wt.path)
      ? git(wt.path, "status", "--porcelain")
      : { ok: false, stdout: "", stderr: "" };
    entry.clean = status.ok && status.stdout.trim() === "";
    const ancestor =
      wt.head !== "" && git(root, "merge-base", "--is-ancestor", wt.head, "origin/main").ok;
    const squashed = merged.find((pr) => pr.headRefName === wt.branch && pr.headRefOid === wt.head);
    if (ancestor) {
      entry.merged = true;
      entry.note = "its commit is in origin/main";
    } else if (squashed !== undefined) {
      entry.merged = true;
      entry.note = `squash-merged as #${squashed.number}`;
    } else {
      entry.note = "not merged: kept";
    }
    if (entry.merged && !entry.clean) {
      entry.note += "; uncommitted changes: kept";
    }
    if (apply && entry.merged && entry.clean) {
      const removed = git(root, "worktree", "remove", wt.path);
      if (removed.ok) {
        entry.removed = true;
        // A merged branch only; git refuses -d for a squash merge, which was checked above.
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

  const pattern = options.targetsGlob ?? join(homedir(), "kalzit-target-*");
  const dir = resolve(pattern, "..");
  const prefix = pattern.slice(pattern.replace(/\\/g, "/").lastIndexOf("/") + 1).replace(/\*$/, "");
  const targets: TargetEntry[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!name.startsWith(prefix) || !statSync(path).isDirectory()) {
        continue;
      }
      const idleHours = (now - lastTouched(path)) / 3_600_000;
      const entry: TargetEntry = {
        path: slash(path),
        bytes: sizeOf(path),
        idleHours: Math.round(idleHours * 10) / 10,
        note:
          idleHours >= idleLimit ? `idle for ${idleLimit} h or more` : "built in recently: kept",
      };
      if (apply && idleHours >= idleLimit) {
        rmSync(path, { recursive: true, force: true });
        entry.removed = true;
      }
      targets.push(entry);
    }
  }
  const reclaimable =
    worktrees
      .filter((w) => w.merged && w.clean && w.note !== "the checkout this runs in")
      .reduce((s, w) => s + w.bytes, 0) +
    targets.filter((t) => t.idleHours >= idleLimit).reduce((s, t) => s + t.bytes, 0);
  return { worktrees, targets, reclaimable, applied: apply, warnings };
}

export function worktreeLines(report: CleanupReport): string[] {
  return lines(
    report.worktrees
      .map(
        (w) =>
          `${w.removed === true ? "removed" : w.merged && w.clean ? "removable" : "kept"}  ${formatBytes(w.bytes).padStart(10)}  ${w.branch}  ${w.path}  (${w.note})`,
      )
      .join("\n"),
  );
}
