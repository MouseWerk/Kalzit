import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { outDir, REPO_DIR, stamp, UI_DIR } from "../paths.ts";
import { createRunDir, freePort, newInstanceId } from "../ports.ts";
import { isAlive, killOwned, run, waitGone } from "../proc.ts";
import { SCREENSHOT_NOW, writeRegionsCsv, writeSalesDatabase } from "./fixtures.ts";
import { removeContainer, startNeo4j } from "./neo4j.ts";
import { type Account, password, type Seeded, seedAi, seedDemo, seedGraph } from "./seed.ts";

const EXE = process.platform === "win32" ? "kalzit.exe" : "kalzit";
const STATE = "instance.json";
const CREDENTIALS = "credentials.json";

export interface InstanceState {
  id: string;
  url: string;
  port: number;
  runDir: string;
  logPath: string;
  binary: string;
  createdAt: string;
  /** The process that owns the instance; it is stopped when that process ends, unless detached. */
  ownerPid: number;
  detached: boolean;
  pids: { kalzit?: number; fakeAi?: number };
  containers: string[];
  /** The fixed moment the fixture data lies around (capture_screens fixes the page clock to it). */
  fixedNow?: number;
  seed?: {
    orgName: string;
    sourceId: string;
    sourceName: string;
    dashboardId: string;
    dashboardTitle: string;
    galleryId: string;
    graph?: { sourceId: string; dashboardId: string };
    ai?: { providerId: string; baseUrl: string };
  };
}

export interface Credentials {
  setupToken: string;
  owner?: Account;
  members?: Account[];
  neo4j?: { user: string; password: string };
}

export interface StartOptions {
  /** A server binary to use instead of building one (also `KALZIT_DEVKIT_BINARY`). */
  binary?: string;
  /** Build even when a binary of the profile exists. */
  rebuild?: boolean;
  /** Cargo profile: `e2e` (default, release settings, builds faster) or `release`. */
  profile?: "e2e" | "release";
  /** Seed the README demo organization (default true). */
  seed?: boolean;
  /** Also start a Neo4j container seeded with graph-shop.cypher and add it as a source. */
  graph?: boolean;
  /** Also start the fake AI provider, connect it and turn AI on. */
  ai?: boolean;
  /** Fixture data around the README screenshot moment instead of now (default true). */
  fixedClock?: boolean;
  /** Keep running after the starting process ends; stop with instance_stop. */
  detached?: boolean;
  /** Progress lines (never credentials). */
  log?: (line: string) => void;
}

export interface StartResult {
  instance: InstanceState;
  credentials: Credentials;
  credentialsPath: string;
}

export function instancesDir(): string {
  return outDir("instances");
}

function targetDir(): string {
  return resolve(REPO_DIR, process.env.CARGO_TARGET_DIR ?? join(REPO_DIR, "target"));
}

/** Builds the UI and the server, or reuses a build. Build output goes to a log file. */
export async function resolveBinary(options: StartOptions): Promise<string> {
  const given = options.binary ?? process.env.KALZIT_DEVKIT_BINARY;
  if (given !== undefined && given !== "") {
    const path = resolve(given);
    if (!existsSync(path)) throw new Error(`binary ${path} does not exist`);
    return path;
  }
  const profile = options.profile ?? "e2e";
  const binary = join(targetDir(), profile, EXE);
  if (existsSync(binary) && options.rebuild !== true) {
    options.log?.(`reusing ${binary} (built ${statSync(binary).mtime.toISOString()})`);
    return binary;
  }
  const logPath = join(outDir("build"), `build-${stamp()}.log`);
  const append = (text: string) => writeFileSync(logPath, text, { flag: "a" });
  const env = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" };
  options.log?.(`building the UI and the server (${profile}); log: ${logPath}`);
  if (!existsSync(join(UI_DIR, "node_modules"))) {
    const ci = await run("npm", ["ci"], { cwd: UI_DIR, env, shell: true, onOutput: append });
    if (ci.code !== 0) throw new Error(`npm ci in ui failed; see ${logPath}`);
  }
  const ui = await run("npm", ["run", "build"], {
    cwd: UI_DIR,
    env,
    shell: true,
    onOutput: append,
  });
  if (ui.code !== 0) throw new Error(`the UI build failed; see ${logPath}`);
  const cargo = await run("cargo", ["build", "--profile", profile, "--locked", "-p", "kalzit"], {
    cwd: REPO_DIR,
    env,
    onOutput: append,
  });
  if (cargo.code !== 0) throw new Error(`cargo build failed; see ${logPath}`);
  return binary;
}

/** The server environment: only what the instance sets, never a `KALZIT_*` of the caller. */
function serverEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith("KALZIT_")) env[name] = value;
  }
  return { ...env, NO_COLOR: "1", ...vars };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function waitListening(pid: number, logPath: string, port: number): Promise<boolean> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal color codes
    const log = readText(logPath).replace(/\u001b\[[0-9;]*m/g, "");
    if (log.includes(`listening on http://127.0.0.1:${port}`)) return true;
    if (!isAlive(pid)) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`kalzit did not listen within 60 s; see ${logPath}`);
}

function spawnDetached(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: string,
): number {
  const fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`${command} could not be started`);
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

function writeState(state: InstanceState): void {
  writeFileSync(join(state.runDir, STATE), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function writeCredentials(runDir: string, credentials: Credentials): string {
  const path = join(runDir, CREDENTIALS);
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** Instances this process owns and stops when it ends (not the detached ones). */
const owned = new Map<string, InstanceState>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const state of owned.values()) stopSync(state);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => process.exit(130));
  }
}

/** The synchronous stop for the exit hook: PIDs and containers of the instance, then its folder. */
function stopSync(state: InstanceState): void {
  for (const pid of Object.values(state.pids)) {
    if (pid !== undefined) killOwned(pid, state.runDir);
  }
  for (const id of state.containers) {
    if (/^[0-9a-f]{12,64}$/.test(id)) {
      try {
        execFileSync("docker", ["rm", "-f", "-v", id], { stdio: "ignore", windowsHide: true });
      } catch {
        // Already gone.
      }
    }
  }
  rmSync(state.runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export async function startInstance(options: StartOptions = {}): Promise<StartResult> {
  const log = options.log ?? (() => {});
  sweepStale();
  const binary = await resolveBinary(options);
  const id = newInstanceId();
  const runDir = createRunDir(instancesDir(), id);
  const state: InstanceState = {
    id,
    url: "",
    port: 0,
    runDir,
    logPath: join(runDir, "server.log"),
    binary,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
    detached: options.detached === true,
    pids: {},
    containers: [],
  };
  if (!state.detached) {
    owned.set(id, state);
    installExitHook();
  }
  const credentials: Credentials = { setupToken: randomBytes(12).toString("hex") };
  try {
    const exe = join(runDir, EXE);
    copyFileSync(binary, exe);
    const fixtures = join(runDir, "fixtures");
    const files = join(runDir, "files");
    mkdirSync(fixtures, { mode: 0o700 });
    mkdirSync(files, { mode: 0o700 });
    const now = options.fixedClock === false ? Date.now() : SCREENSHOT_NOW;
    if (options.fixedClock !== false) state.fixedNow = now;
    writeSalesDatabase(join(fixtures, "sales.db"), now);
    writeRegionsCsv(join(files, "regions.csv"));

    const env = serverEnv({
      KALZIT_PATHS_DATA_DIR: join(runDir, "data"),
      KALZIT_SETUP_TOKEN: credentials.setupToken,
      KALZIT_SECRETS_KEY: randomBytes(32).toString("base64"),
      KALZIT_SETTING_DATASOURCES_SQLITE_DIRS: JSON.stringify([fixtures]),
      KALZIT_SETTING_DATASOURCES_FILE_DIRS: JSON.stringify([files]),
      KALZIT_SETTING_APPEARANCE_DEFAULT_LANGUAGE: "en",
      KALZIT_LOG_LEVEL: "info",
    });
    const taken = new Set<number>();
    for (let attempt = 0; attempt < 3 && state.url === ""; attempt++) {
      const port = await freePort(taken);
      taken.add(port);
      const pid = spawnDetached(
        exe,
        ["serve"],
        runDir,
        { ...env, KALZIT_SERVER_HTTP_ADDR: `127.0.0.1:${port}` },
        state.logPath,
      );
      state.pids.kalzit = pid;
      writeState(state);
      if (await waitListening(pid, state.logPath, port)) {
        state.port = port;
        state.url = `http://127.0.0.1:${port}`;
      }
    }
    if (state.url === "") {
      throw new Error(`kalzit exited before listening; see ${state.logPath}`);
    }
    log(`kalzit ${id} on ${state.url}`);
    writeCredentials(runDir, credentials);

    if (options.seed !== false) {
      const { client, seeded } = await seedDemo(state.url, credentials.setupToken, fixtures, id);
      credentials.owner = seeded.owner;
      credentials.members = seeded.members;
      state.seed = publicSeed(seeded);
      log("seeded the README demo organization");
      if (options.graph === true) {
        const neo4jPassword = password();
        log("starting Neo4j");
        const neo4j = await startNeo4j(id, neo4jPassword);
        state.containers.push(neo4j.containerId);
        writeState(state);
        credentials.neo4j = { user: neo4j.user, password: neo4jPassword };
        state.seed.graph = await seedGraph(client, neo4j);
        log(`Neo4j on 127.0.0.1:${neo4j.port}, seeded with graph-shop.cypher`);
      }
      if (options.ai === true) {
        const aiPort = await freePort(new Set([state.port]));
        // From dist the built script; from src (the smoke test) Node runs the TypeScript itself.
        const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
        const script = fileURLToPath(new URL(`./fakeai.${ext}`, import.meta.url));
        state.pids.fakeAi = spawnDetached(
          process.execPath,
          [script, String(aiPort), runDir],
          runDir,
          process.env,
          join(runDir, "fakeai.log"),
        );
        writeState(state);
        const baseUrl = `http://127.0.0.1:${aiPort}/v1`;
        await waitHttp(`${baseUrl}/models`);
        const sources = [state.seed.sourceId];
        if (state.seed.graph !== undefined) sources.push(state.seed.graph.sourceId);
        const ai = await seedAi(client, baseUrl, sources);
        state.seed.ai = { ...ai, baseUrl };
        log("fake AI provider connected, AI on");
      }
    }
    writeState(state);
    const credentialsPath = writeCredentials(runDir, credentials);
    return { instance: state, credentials, credentialsPath };
  } catch (error) {
    await stopState(state);
    owned.delete(id);
    throw error;
  }
}

function publicSeed(seeded: Seeded): NonNullable<InstanceState["seed"]> {
  return {
    orgName: seeded.orgName,
    sourceId: seeded.sourceId,
    sourceName: seeded.sourceName,
    dashboardId: seeded.dashboardId,
    dashboardTitle: seeded.dashboardTitle,
    galleryId: seeded.galleryId,
  };
}

async function waitHttp(url: string): Promise<void> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not answer within 15 s`);
}

async function stopState(state: InstanceState): Promise<void> {
  for (const pid of Object.values(state.pids)) {
    if (pid !== undefined && killOwned(pid, state.runDir)) {
      await waitGone(pid, state.runDir);
    }
  }
  for (const container of state.containers) await removeContainer(container);
  rmSync(state.runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export function readState(runDir: string): InstanceState | undefined {
  try {
    return JSON.parse(readFileSync(join(runDir, STATE), "utf8")) as InstanceState;
  } catch {
    return undefined;
  }
}

export function readCredentials(state: InstanceState): Credentials | undefined {
  try {
    return JSON.parse(readFileSync(join(state.runDir, CREDENTIALS), "utf8")) as Credentials;
  } catch {
    return undefined;
  }
}

function allStates(): { dir: string; state: InstanceState | undefined }[] {
  const base = instancesDir();
  return readdirSync(base)
    .filter((name) => name.startsWith("inst-"))
    .map((name) => ({ dir: join(base, name), state: readState(join(base, name)) }));
}

export interface ListedInstance extends InstanceState {
  running: boolean;
}

/** Instances in the output folder that still run; stale ones are cleaned up on the way. */
export function listInstances(): ListedInstance[] {
  sweepStale();
  return allStates().flatMap(({ state }) =>
    state === undefined
      ? []
      : [{ ...state, running: state.pids.kalzit !== undefined && isAlive(state.pids.kalzit) }],
  );
}

/**
 * Removes instances whose owner ended without stopping them (and that were not detached), whose
 * server is gone, or whose folder has no state (a start that crashed). Their processes and
 * containers are stopped by PID and id only.
 */
export function sweepStale(): void {
  for (const { dir, state } of allStates()) {
    if (state === undefined) {
      // A start in progress writes its state within a second; only old folders are leftovers.
      if (Date.now() - statSync(dir).mtimeMs > 10 * 60_000) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
      continue;
    }
    if (owned.has(state.id)) continue;
    const ownerGone = !state.detached && !isAlive(state.ownerPid);
    const serverGone = state.pids.kalzit === undefined || !isAlive(state.pids.kalzit);
    const young = Date.now() - Date.parse(state.createdAt) < 120_000;
    if (ownerGone || (serverGone && !young)) stopSync(state);
  }
}

/** Stops one instance (by id) or all of them in the output folder. */
export async function stopInstance(id: string): Promise<string[]> {
  const stopped: string[] = [];
  for (const { state } of allStates()) {
    if (state === undefined || (id !== "all" && state.id !== id)) continue;
    await stopState(state);
    owned.delete(state.id);
    stopped.push(state.id);
  }
  if (stopped.length === 0 && id !== "all") throw new Error(`no instance ${id}`);
  return stopped;
}

/** The newest running instance, or the one with this id; for the tools that need one. */
export function findInstance(id?: string): { state: InstanceState; credentials: Credentials } {
  const running = listInstances().filter((i) => i.running);
  const state =
    id === undefined || id === ""
      ? running.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : running.find((i) => i.id === id);
  if (state === undefined) {
    throw new Error(
      id === undefined
        ? "no running instance; start one with instance_start"
        : `no running instance ${id}`,
    );
  }
  const credentials = readCredentials(state);
  if (credentials?.owner === undefined) {
    throw new Error(`instance ${state.id} has no seeded owner; start it with seed on`);
  }
  return { state, credentials };
}
