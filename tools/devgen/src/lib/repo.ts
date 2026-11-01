import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository the tools work on, and the commands they run against it. Every command takes
 * its arguments as a list (no shell), so paths with spaces work on Windows and Linux alike.
 */

/** The repository root: `KALZIT_REPO`, else the checkout that contains this package. */
export function repoRoot(start?: string): string {
  const fromEnv = process.env.KALZIT_REPO;
  if (fromEnv !== undefined && fromEnv !== "") {
    return resolve(fromEnv);
  }
  let dir = start ?? dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "server", "migrations")) && existsSync(join(dir, "ui", "src"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Kalzit repository not found; set KALZIT_REPO to its root");
    }
    dir = parent;
  }
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs a program and returns its output; never throws for a non-zero exit. */
export function run(cmd: string, args: readonly string[], cwd: string): RunResult {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
    };
  }
}

export function git(cwd: string, ...args: string[]): RunResult {
  return run("git", args, cwd);
}

/** Lines of a command's output, without empty ones. */
export function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Reads a text file with LF line endings. */
export function readText(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** Writes a text file with LF line endings (the repository's .gitattributes asks for LF). */
export function writeText(path: string, text: string): void {
  writeFileSync(path, text.replace(/\r\n/g, "\n"), "utf8");
}

/** Forward slashes, so paths compare equal on Windows and Linux. */
export function slash(path: string): string {
  return path.replace(/\\/g, "/");
}
