import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the approved baselines come from. They live in a repository of their own
 * (MouseWerk/kalzit-visual); `baselines.lock` next to this file names it and the commit Kalzit
 * compares against. A run fetches that commit into a cache folder once; `visual:update` writes
 * into a checkout of that repository instead (KALZIT_VISUAL_BASELINES), whose change becomes a
 * pull request there and a new commit in the lock here (docs/process.md, "Visual comparison").
 *
 *   node e2e/visual/baselines.ts fetch      fetch the locked commit (npm run visual does this)
 *   node e2e/visual/baselines.ts checkout   check that KALZIT_VISUAL_BASELINES is a checkout
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCK = join(HERE, "baselines.lock");

export interface Lock {
  repo: string;
  commit: string;
}

export function readLock(): Lock {
  const values = Object.fromEntries(
    readFileSync(LOCK, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
  const repo = values.repo ?? "";
  const commit = values.commit ?? "";
  if (repo === "" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`${LOCK} needs repo=<url> and commit=<40 hex digits>`);
  }
  return { repo, commit };
}

/** A checkout of the baselines repository to write into, for `visual:update`. */
function checkout(): string | undefined {
  const given = process.env.KALZIT_VISUAL_BASELINES ?? "";
  return given === "" ? undefined : resolve(given);
}

/**
 * The folder whose `baselines/` the run compares against: the checkout given for an update, or
 * the locked commit in the cache (KALZIT_VISUAL_CACHE, default e2e/.visual-baselines).
 */
export function baselineRoot(): string {
  const given = checkout();
  if (given !== undefined) {
    return given;
  }
  const cache = resolve(process.env.KALZIT_VISUAL_CACHE ?? join(HERE, "..", ".visual-baselines"));
  return join(cache, readLock().commit);
}

export const baselineDir = (): string => join(baselineRoot(), "baselines");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

/** Fetches the locked commit into the cache, unless it is there already. */
function fetchLocked(): void {
  const { repo, commit } = readLock();
  const root = baselineRoot();
  if (existsSync(join(root, ".git")) && git(root, "rev-parse", "HEAD") === commit) {
    process.stdout.write(`visual: baselines ${commit.slice(0, 9)} from the cache\n`);
    return;
  }
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet");
  git(root, "fetch", "--quiet", "--depth", "1", repo, commit);
  git(root, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "FETCH_HEAD");
  process.stdout.write(`visual: baselines ${commit.slice(0, 9)} fetched from ${repo}\n`);
}

function requireCheckout(): void {
  const given = checkout();
  if (given === undefined || !existsSync(join(given, ".git"))) {
    process.stderr.write(
      "visual:update writes into a checkout of the baselines repository:\n" +
        `  git clone ${readLock().repo} ../../kalzit-visual   (from ui/, beside the Kalzit checkout)\n` +
        "  KALZIT_VISUAL_BASELINES=../../kalzit-visual npm run visual:update\n" +
        "then open a pull request there and put its merged commit into e2e/visual/baselines.lock.\n",
    );
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "fetch") {
    // An update writes into its checkout; only a comparison needs the locked commit.
    if (checkout() === undefined) {
      fetchLocked();
    }
  } else if (command === "checkout") {
    requireCheckout();
  } else {
    process.stderr.write("usage: node e2e/visual/baselines.ts fetch|checkout\n");
    process.exit(2);
  }
}
