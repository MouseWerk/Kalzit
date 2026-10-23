import { type ChildProcess, execFileSync, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeRegionsCsv, writeSalesDatabase } from "./support/fixture-db";

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(UI_DIR, "..");
/** Report, traces and the server log; CI uploads this folder when a run fails. */
export const OUTPUT_DIR = join(UI_DIR, "e2e", ".output");
const EXE = process.platform === "win32" ? "kalzit.exe" : "kalzit";
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

/**
 * The release binary to test: `KALZIT_E2E_BINARY` when set (CI builds it in its own step),
 * otherwise the UI and the server are built here, so a local run always tests the current code.
 * Cargo builds nothing when the binary is current; the UI build takes a few seconds.
 */
function locateBinary(): string {
  const given = process.env.KALZIT_E2E_BINARY;
  if (given !== undefined && given !== "") {
    const path = resolve(given);
    if (!existsSync(path)) {
      throw new Error(`KALZIT_E2E_BINARY points to ${path}, which does not exist`);
    }
    return path;
  }
  // One command line without arguments to escape: npm is a script on Windows, run by the shell.
  execSync("npm run build", { cwd: UI_DIR, stdio: "inherit" });
  execFileSync("cargo", ["build", "--release", "--locked", "-p", "kalzit"], {
    cwd: REPO_DIR,
    stdio: "inherit",
  });
  const target = process.env.CARGO_TARGET_DIR ?? join(REPO_DIR, "target");
  return join(resolve(REPO_DIR, target), "release", EXE);
}

const PID_FILE = "kalzit.pid";
const RUN_FOLDER = /^run-\d+-(\d+)$/;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The executable of a running process, or undefined when it cannot be told. */
function executableOf(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      const path = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).Path`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return path === "" ? undefined : path;
    }
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return undefined;
  }
}

function isInside(path: string, folder: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Removes what earlier runs left behind when they crashed before their teardown. A folder is
 * only touched when the test runner that made it (its PID is in the folder name) is gone, so a
 * run in progress elsewhere is left alone. Its server is stopped only when the recorded PID
 * still runs the binary copied into that folder, never another process that reuses the PID.
 */
function sweepOldRuns(base: string): void {
  for (const name of readdirSync(base)) {
    const runner = RUN_FOLDER.exec(name)?.[1];
    if (runner === undefined || isAlive(Number(runner))) {
      continue;
    }
    const folder = join(base, name);
    const pidFile = join(folder, PID_FILE);
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      const exe = Number.isSafeInteger(pid) && pid > 0 ? executableOf(pid) : undefined;
      if (exe !== undefined && isInside(exe, folder)) {
        process.kill(pid, "SIGKILL");
      }
    }
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * Every run gets a folder of its own below `KALZIT_E2E_RUN_DIR` (default: the system temp
 * folder): the copied binary, the fixture folder and the server's PID. The data directory inside
 * it does not exist yet, so the server creates it private, as on a real first start.
 */
function prepareRunDir(): string {
  const base = resolve(process.env.KALZIT_E2E_RUN_DIR ?? join(tmpdir(), "kalzit-e2e"));
  mkdirSync(base, { recursive: true, mode: 0o700 });
  sweepOldRuns(base);
  const run = join(base, `run-${Date.now()}-${process.pid}`);
  mkdirSync(run, { mode: 0o700 });
  return run;
}

function removeRunDir(run: string): void {
  if (process.env.KALZIT_E2E_KEEP !== "1") {
    rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** The server environment: only what the run sets, never a `KALZIT_*` of the caller's shell. */
function serverEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith("KALZIT_")) {
      env[name] = value;
    }
  }
  return { ...env, NO_COLOR: "1", ...vars };
}

function waitForAddress(child: ChildProcess, log: (line: string) => void): Promise<string> {
  return new Promise((resolveAddress, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      reject(new Error(`kalzit did not report its address within ${START_TIMEOUT_MS} ms`));
    }, START_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log(text);
      buffered += text;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal color codes
      const plain = buffered.replace(/\u001b\[[0-9;]*m/g, "");
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(plain);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolveAddress(match[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`kalzit exited with code ${code} before listening; see the server log`));
    });
    // The binary could not be started at all (missing, not executable).
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Stops the server this setup started, by its PID only, and waits until it is gone. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  // SIGTERM is the server's graceful stop on Linux; on Windows Node ends the process directly.
  child.kill("SIGTERM");
  const timeout = new Promise<"timeout">((done) =>
    setTimeout(() => done("timeout"), STOP_TIMEOUT_MS),
  );
  if ((await Promise.race([exited, timeout])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const binary = locateBinary();
  const run = prepareRunDir();
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const logPath = join(OUTPUT_DIR, "server.log");
  const logFile = createWriteStream(logPath);
  let child: ChildProcess | undefined;
  const cleanUp = async () => {
    if (child !== undefined) {
      await stop(child);
    }
    logFile.end();
    removeRunDir(run);
  };

  try {
    const exe = join(run, EXE);
    copyFileSync(binary, exe);
    const fixtures = join(run, "fixtures");
    mkdirSync(fixtures, { mode: 0o700 });
    // The screenshots fix the clock, so their data lies around that moment instead of now.
    const fixedNow = Number(process.env.KALZIT_E2E_FIXTURE_NOW ?? "");
    writeSalesDatabase(
      join(fixtures, "sales.db"),
      Number.isFinite(fixedNow) && fixedNow > 0 ? fixedNow : Date.now(),
    );
    // CSV and JSON files live in a folder of their own: the server keeps the SQLite and the file
    // folders apart, so a folder allowed for one does not open the other.
    const files = join(run, "files");
    mkdirSync(files, { mode: 0o700 });
    writeRegionsCsv(join(files, "regions.csv"));

    const setupToken = randomBytes(12).toString("hex");
    child = spawn(exe, ["serve"], {
      cwd: run,
      env: serverEnv({
        KALZIT_SERVER_HTTP_ADDR: "127.0.0.1:0",
        KALZIT_PATHS_DATA_DIR: join(run, "data"),
        KALZIT_SETUP_TOKEN: setupToken,
        KALZIT_SECRETS_KEY: randomBytes(32).toString("base64"),
        KALZIT_SETTING_DATASOURCES_SQLITE_DIRS: JSON.stringify([fixtures]),
        KALZIT_SETTING_DATASOURCES_FILE_DIRS: JSON.stringify([files]),
        // Accounts without a language of their own read English; the German runs sign in as an
        // account whose preference is German (support/api.ts, OWNER_DE).
        KALZIT_SETTING_APPEARANCE_DEFAULT_LANGUAGE: "en",
        KALZIT_LOG_LEVEL: "info",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const address = waitForAddress(child, (text) => logFile.write(text));
    if (child.pid !== undefined) {
      // For the next setup, should this run crash before its teardown.
      writeFileSync(join(run, PID_FILE), `${child.pid}\n`);
    }
    const url = await address.catch((error: Error) => {
      throw new Error(`${error.message} (${logPath})`);
    });

    process.env.KALZIT_E2E_URL = url;
    process.env.KALZIT_E2E_SETUP_TOKEN = setupToken;
    process.env.KALZIT_E2E_FIXTURES = fixtures;
    process.env.KALZIT_E2E_FILES = files;
    process.env.KALZIT_E2E_DATA_DIR = join(run, "data");
    process.stdout.write(`kalzit e2e server on ${url}, run folder ${run}\n`);
  } catch (error) {
    await cleanUp();
    throw error;
  }
  return cleanUp;
}
