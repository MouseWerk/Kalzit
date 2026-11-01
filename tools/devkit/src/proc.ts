import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds; the process is ended (by its PID) when it runs longer. */
  timeoutMs?: number;
  /** Text written to stdin. */
  input?: string;
  /** Called with each chunk of output, for progress or a log file. */
  onOutput?: (text: string) => void;
}

/**
 * Runs a program and collects its output. Never throws for a non-zero exit; the caller reads
 * `code`. `shell` is for npm and npx, which are scripts on Windows; the command line is then
 * passed as one string and must be built from trusted parts only.
 */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions & { shell?: boolean } = {},
): Promise<RunResult> {
  return new Promise((done) => {
    const child = options.shell
      ? spawn([command, ...args].join(" "), {
          cwd: options.cwd,
          env: options.env ?? process.env,
          shell: true,
          windowsHide: true,
        })
      : spawn(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          windowsHide: true,
        });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      options.onOutput?.(text);
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
    child.once("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      done({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Like `run`, but throws with the output's tail when the program fails. */
export async function runChecked(
  command: string,
  args: readonly string[],
  options: RunOptions & { shell?: boolean } = {},
): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-20).join("\n");
    // Only the program and its subcommand: arguments may carry values that belong in no log.
    throw new Error(`${command} ${args[0] ?? ""} failed with code ${result.code}:\n${tail}`);
  }
  return result.stdout;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The command line of a running process, or undefined when it cannot be told. */
export function commandLineOf(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      const line = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop).CommandLine`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      ).trim();
      return line === "" ? undefined : line;
    }
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    return undefined;
  }
}

/**
 * Ends a process this toolkit started, by its PID only, and only when its command line still
 * names `marker` (the instance's run folder), so a PID reused by another process is left alone.
 * Returns whether a process was ended.
 */
export function killOwned(pid: number, marker: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) {
    return false;
  }
  const line = commandLineOf(pid);
  if (line === undefined || !normalise(line).includes(normalise(marker))) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  return true;
}

/** Waits until a PID is gone, up to `timeoutMs`; ends it hard after that (same ownership rule). */
export async function waitGone(pid: number, marker: string, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isAlive(pid)) {
    const line = commandLineOf(pid);
    if (line !== undefined && normalise(line).includes(normalise(marker))) {
      process.kill(pid, "SIGKILL");
    }
  }
}

function normalise(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}
