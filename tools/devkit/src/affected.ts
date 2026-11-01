import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outDir, REPO_DIR, stamp } from "./paths.ts";
import { run } from "./proc.ts";

/** The repository as the mapping sees it: tracked files (POSIX paths) and their contents. */
export interface RepoView {
  files: readonly string[];
  read: (path: string) => string;
}

export interface TestCommand {
  kind: "cargo" | "vitest" | "playwright" | "script" | "devkit";
  /** Folder to run in, relative to the repository root. */
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Why these tests: the changed paths that led to them. */
  because: string[];
}

export interface Affected {
  changed: string[];
  commands: TestCommand[];
  /** Changed paths no rule covers (documentation, assets). */
  uncovered: string[];
}

const basenameNoExt = (path: string) => (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");

/** The Cargo package of each Rust crate folder, from its Cargo.toml. */
function crates(repo: RepoView): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of repo.files) {
    if (!file.endsWith("/Cargo.toml")) continue;
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(repo.read(file))?.[1];
    if (name !== undefined) map.set(file.slice(0, -"/Cargo.toml".length), name);
  }
  return map;
}

/** The module path of a server source file as a test filter: server/src/ai/chat.rs -> ai::chat. */
export function rustFilter(path: string): string | undefined {
  const rel = path.replace(/^server\/src\//, "").replace(/\.rs$/, "");
  if (rel === "lib" || rel === "main") return undefined;
  return rel
    .replace(/\/mod$/, "")
    .split("/")
    .join("::");
}

/** The word integration tests are named after: the top module, or the route under routes/. */
function serverKeyword(path: string): string {
  const parts = path
    .replace(/^server\/src\//, "")
    .replace(/\.rs$/, "")
    .split("/");
  const first = parts[0] ?? "";
  return first === "routes" && parts[1] !== undefined ? parts[1].replace(/\.rs$/, "") : first;
}

const IMPORT_FROM = /from\s+["']([^"']+)["']/g;

/** Relative imports of a file, resolved to repository paths without extension. */
function importsOf(file: string, text: string): string[] {
  const dir = file.split("/").slice(0, -1);
  const found: string[] = [];
  for (const match of text.matchAll(IMPORT_FROM)) {
    const spec = match[1] ?? "";
    if (!spec.startsWith(".")) continue;
    const parts = [...dir];
    for (const segment of spec.split("/")) {
      if (segment === "..") parts.pop();
      else if (segment !== ".") parts.push(segment);
    }
    found.push(parts.join("/").replace(/\.(tsx?|jsx?|mjs)$/, ""));
  }
  return found;
}

/**
 * Maps changed paths to the tests that cover them:
 * - Rust: integration tests in server/tests by name, unit tests of the changed modules by filter,
 *   and the whole package for other crates, migrations and the test helpers.
 * - UI: the vitest files that are or import a changed file (or sit next to it), and the
 *   Playwright specs that are, or import, a changed e2e file, or are named after the feature.
 * - The change detection script, and the devkit's own tests.
 */
export function mapAffected(changed: readonly string[], repo: RepoView): Affected {
  const cargoTests = new Map<string, Set<string>>();
  const libFilters = new Set<string>();
  const wholeCrates = new Set<string>();
  const vitest = new Set<string>();
  const specs = new Set<string>();
  const because = new Map<string, Set<string>>();
  const uncovered: string[] = [];
  const add = (key: string, path: string) => {
    let set = because.get(key);
    if (set === undefined) {
      set = new Set();
      because.set(key, set);
    }
    set.add(path);
  };
  const crateOf = crates(repo);
  const serverTests = repo.files.filter((f) => /^server\/tests\/[^/]+\.rs$/.test(f));
  const uiTests = repo.files.filter((f) => /^ui\/src\/.+\.test\.tsx?$/.test(f));
  const e2eSpecs = repo.files.filter((f) => /^ui\/e2e\/[^/]+\.spec\.ts$/.test(f));
  const importers = (target: string, among: readonly string[]) =>
    among.filter((f) => importsOf(f, repo.read(f)).includes(target));

  for (const path of changed) {
    let covered = true;
    if (path === "Cargo.toml" || path === "Cargo.lock") {
      wholeCrates.add("--workspace");
      add("cargo-whole", path);
    } else if (/^server\/tests\/[^/]+\.rs$/.test(path)) {
      const name = basenameNoExt(path);
      cargoTests.set(name, new Set([path]));
      add("cargo-tests", path);
    } else if (
      path.startsWith("server/tests/") ||
      path.startsWith("server/migrations/") ||
      path === "server/Cargo.toml" ||
      path === "server/build.rs"
    ) {
      wholeCrates.add("kalzit");
      add("cargo-whole", path);
    } else if (/^server\/src\/.+\.rs$/.test(path)) {
      const filter = rustFilter(path);
      if (filter === undefined) {
        wholeCrates.add("kalzit");
        add("cargo-whole", path);
      } else {
        libFilters.add(filter);
        add("cargo-lib", path);
        const keyword = serverKeyword(path).replace(/_/g, "");
        for (const test of serverTests) {
          const name = basenameNoExt(test);
          if (keyword.length >= 2 && name.replace(/_/g, "").startsWith(keyword)) {
            cargoTests.set(name, new Set([path]));
            add("cargo-tests", path);
          }
        }
      }
    } else if (path.startsWith("server/")) {
      wholeCrates.add("kalzit");
      add("cargo-whole", path);
    } else if (
      /\.(rs|toml)$/.test(path) &&
      [...crateOf.keys()].some((dir) => path.startsWith(`${dir}/`))
    ) {
      const dir = [...crateOf.keys()]
        .filter((d) => path.startsWith(`${d}/`))
        .sort((a, b) => b.length - a.length)[0];
      const name = dir === undefined ? undefined : crateOf.get(dir);
      if (name !== undefined) {
        wholeCrates.add(name);
        add("cargo-whole", path);
      }
    } else if (/^ui\/src\/.+\.test\.tsx?$/.test(path)) {
      vitest.add(path);
      add("vitest", path);
    } else if (/^ui\/src\/.+\.(tsx?|json)$/.test(path)) {
      const target = path.replace(/\.(tsx?|json)$/, "");
      const direct = importers(target, uiTests);
      const name = basenameNoExt(path);
      const dir = path.split("/").slice(0, -1).join("/");
      const siblings = uiTests.filter(
        (t) => t.startsWith(`${dir}/${name}.`) || t.startsWith(`${dir}/${name}`),
      );
      let found = [...new Set([...direct, ...siblings])];
      if (found.length === 0) {
        // Named after the file's topic in the same folder: TeamsPage.tsx and teams.test.tsx.
        const topic = name.toLowerCase().replace(/(page|dialog|panel|view|form)$/, "");
        found = uiTests.filter((t) => {
          const test = basenameNoExt(t)
            .replace(/\.test$/, "")
            .toLowerCase();
          return t.startsWith(`${dir}/`) && topic.length >= 3 && test.startsWith(topic);
        });
      }
      if (path.startsWith("ui/src/i18n/")) found = uiTests.filter((t) => t.includes("i18n"));
      if (found.length === 0)
        found = uiTests.filter((t) => t.split("/").slice(0, -1).join("/") === dir);
      for (const t of found) {
        vitest.add(t);
        add("vitest", path);
      }
      // The Playwright specs named after the feature folder (ui/src/features/<name>/...).
      const feature = /^ui\/src\/(?:features\/)?([^/]+)\//.exec(path)?.[1];
      if (feature !== undefined) {
        for (const spec of e2eSpecs) {
          const specName = basenameNoExt(spec).replace(/\.spec$/, "");
          if (
            feature.startsWith(specName.replace(/s$/, "")) ||
            specName.startsWith(feature.replace(/s$/, ""))
          ) {
            specs.add(spec);
            add("playwright", path);
          }
        }
      }
      if (found.length === 0 && feature === undefined) covered = false;
    } else if (/^ui\/src\/.+\.css$/.test(path)) {
      for (const spec of ["ui/e2e/layout.spec.ts", "ui/e2e/a11y.spec.ts"]) {
        if (e2eSpecs.includes(spec)) {
          specs.add(spec);
          add("playwright", path);
        }
      }
    } else if (/^ui\/e2e\/[^/]+\.spec\.ts$/.test(path)) {
      specs.add(path);
      add("playwright", path);
    } else if (/^ui\/e2e\/support\/.+\.ts$/.test(path)) {
      const target = path.replace(/\.ts$/, "");
      const users = importers(target, e2eSpecs);
      for (const spec of users.length > 0 ? users : e2eSpecs) {
        specs.add(spec);
        add("playwright", path);
      }
    } else if (
      path === "ui/e2e/global-setup.ts" ||
      path === "ui/e2e/playwright.config.ts" ||
      path === "ui/e2e/first-run.setup.ts"
    ) {
      for (const spec of e2eSpecs) specs.add(spec);
      add("playwright", path);
    } else if (path.startsWith(".github/scripts/changes")) {
      add("changes", path);
    } else if (path.startsWith("tools/devkit/")) {
      add("devkit", path);
    } else {
      covered = false;
    }
    if (!covered) uncovered.push(path);
  }

  const commands: TestCommand[] = [];
  const jobsEnv = { CARGO_BUILD_JOBS: "2" };
  const reasons = (...keys: string[]) => [
    ...new Set(keys.flatMap((k) => [...(because.get(k) ?? [])])),
  ];
  if (wholeCrates.size > 0) {
    const args = wholeCrates.has("--workspace")
      ? ["test", "--locked", "--workspace"]
      : ["test", "--locked", ...[...wholeCrates].sort().flatMap((c) => ["-p", c])];
    commands.push({
      kind: "cargo",
      cwd: ".",
      command: "cargo",
      args,
      env: jobsEnv,
      because: reasons("cargo-whole"),
    });
  }
  const kalzitWhole = wholeCrates.has("kalzit") || wholeCrates.has("--workspace");
  if (!kalzitWhole && cargoTests.size > 0) {
    commands.push({
      kind: "cargo",
      cwd: ".",
      command: "cargo",
      args: [
        "test",
        "--locked",
        "-p",
        "kalzit",
        ...[...cargoTests.keys()].sort().flatMap((t) => ["--test", t]),
      ],
      env: jobsEnv,
      because: reasons("cargo-tests"),
    });
  }
  if (!kalzitWhole && libFilters.size > 0) {
    commands.push({
      kind: "cargo",
      cwd: ".",
      command: "cargo",
      args: ["test", "--locked", "-p", "kalzit", "--lib", "--", ...[...libFilters].sort()],
      env: jobsEnv,
      because: reasons("cargo-lib"),
    });
  }
  if (vitest.size > 0) {
    commands.push({
      kind: "vitest",
      cwd: "ui",
      command: "npx",
      args: [
        "vitest",
        "run",
        "--maxWorkers=2",
        ...[...vitest].sort().map((f) => f.replace(/^ui\//, "")),
      ],
      because: reasons("vitest"),
    });
  }
  if (specs.size > 0) {
    commands.push({
      kind: "playwright",
      cwd: "ui",
      command: "npx",
      args: [
        "playwright",
        "test",
        "-c",
        "e2e/playwright.config.ts",
        "--project=chromium",
        "--workers=2",
        ...[...specs].sort().map((f) => f.replace(/^ui\//, "")),
      ],
      env: { KALZIT_E2E_BROWSERS: "chromium", CARGO_BUILD_JOBS: "2" },
      because: reasons("playwright"),
    });
  }
  if (because.has("changes")) {
    commands.push({
      kind: "script",
      cwd: ".",
      command: "bash",
      args: [".github/scripts/changes.test.sh"],
      because: reasons("changes"),
    });
  }
  if (because.has("devkit")) {
    commands.push({
      kind: "devkit",
      cwd: "tools/devkit",
      command: "npm",
      args: ["test"],
      because: reasons("devkit"),
    });
  }
  return { changed: [...changed], commands, uncovered };
}

export function commandLine(c: TestCommand): string {
  const env = Object.entries(c.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const cd = c.cwd === "." ? "" : `(cd ${c.cwd} && `;
  return `${cd}${env === "" ? "" : `${env} `}${c.command} ${c.args.join(" ")}${cd === "" ? "" : ")"}`;
}

export interface AffectedOptions {
  /** The base to compare with (default origin/main). */
  base?: string;
  /** Also count uncommitted changes in the working tree (default true). */
  includeWorkingTree?: boolean;
  /** Paths to map instead of a diff. */
  paths?: string[];
  /** Run the commands (default false: only suggest them). */
  run?: boolean;
}

export interface AffectedResult extends Affected {
  base: string;
  suggested: string[];
  results?: { command: string; code: number; log: string; tail: string }[];
}

async function git(args: string[]): Promise<string> {
  const result = await run("git", args, { cwd: REPO_DIR });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function affectedTests(options: AffectedOptions): Promise<AffectedResult> {
  const base = options.base ?? "origin/main";
  let changed = options.paths;
  if (changed === undefined) {
    const names = new Set(
      (await git(["diff", "--name-only", `${base}...HEAD`])).split("\n").filter((l) => l !== ""),
    );
    if (options.includeWorkingTree !== false) {
      for (const line of (await git(["diff", "--name-only", "HEAD"])).split("\n"))
        if (line !== "") names.add(line);
      for (const line of (await git(["ls-files", "--others", "--exclude-standard"])).split("\n")) {
        if (line !== "") names.add(line);
      }
    }
    changed = [...names].sort();
  }
  const files = (await git(["ls-files"])).split("\n").filter((l) => l !== "");
  const cache = new Map<string, string>();
  const view: RepoView = {
    files,
    read: (path) => {
      let text = cache.get(path);
      if (text === undefined) {
        try {
          text = readFileSync(join(REPO_DIR, path), "utf8");
        } catch {
          text = "";
        }
        cache.set(path, text);
      }
      return text;
    },
  };
  const affected = mapAffected(changed, view);
  const result: AffectedResult = {
    base,
    ...affected,
    suggested: affected.commands.map(commandLine),
  };
  if (options.run === true) {
    const dir = outDir("tests", stamp());
    result.results = [];
    for (const [index, c] of affected.commands.entries()) {
      const log = join(dir, `${index + 1}-${c.kind}.log`);
      const env: NodeJS.ProcessEnv = { ...process.env, ...c.env };
      if (c.env?.CARGO_BUILD_JOBS !== undefined && process.env.CARGO_BUILD_JOBS !== undefined) {
        env.CARGO_BUILD_JOBS = process.env.CARGO_BUILD_JOBS;
      }
      if (c.kind === "playwright") env.KALZIT_E2E_RUN_DIR = outDir("e2e-runs", stamp());
      const shell = c.command === "npx" || c.command === "npm";
      const r = await run(c.command, c.args, { cwd: join(REPO_DIR, c.cwd), env, shell });
      const output = `${r.stdout}\n${r.stderr}`;
      writeFileSync(log, output);
      result.results.push({
        command: commandLine(c),
        code: r.code,
        log,
        tail: output.trim().split("\n").slice(-15).join("\n"),
      });
    }
  }
  return result;
}
