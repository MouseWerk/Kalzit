import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** tools/devkit, whether this runs from src (tests) or dist (the built CLI and server). */
export const DEVKIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The repository the devkit belongs to: the checkout or worktree it was built in. */
export const REPO_DIR = resolve(DEVKIT_DIR, "..", "..");
export const UI_DIR = join(REPO_DIR, "ui");

/**
 * Where outputs go: `KALZIT_DEVKIT_OUT`, otherwise tools/devkit/.out (gitignored). Instances,
 * captures, diffs, checks and CI logs each get a subfolder.
 */
export function outDir(...parts: string[]): string {
  const base = resolve(process.env.KALZIT_DEVKIT_OUT ?? join(DEVKIT_DIR, ".out"));
  const dir = join(base, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A folder name that sorts by time and never repeats: `2026-11-01T10-20-30-123Z-1a2b`. */
export function stamp(): string {
  const random = Math.random().toString(36).slice(2, 6);
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${random}`;
}
