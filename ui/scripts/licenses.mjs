// Writes public/third-party-licenses.json: the Rust crates the server ships and the npm packages
// of the UI's production dependency tree, each with name, version and license. `npm run build`
// runs it, so the file lands in the UI bundle that the server embeds (Settings, About).
//
// Rust: `cargo metadata`, following only normal dependencies from the `kalzit` package (build
// and dev dependencies are not part of the binary). npm: package-lock.json, entries that are not
// dev-only (the lock file carries each package's license). No extra tools.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "..");
const repoRoot = resolve(uiRoot, "..");
const OUTPUT = resolve(uiRoot, "public", "third-party-licenses.json");
const ROOT_PACKAGE = "kalzit";

/** The crates (without the workspace's own) reachable through normal dependencies. */
export function fromCargoMetadata(metadata) {
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const members = new Set(metadata.workspace_members);
  const root = metadata.packages.find((pkg) => pkg.name === ROOT_PACKAGE && members.has(pkg.id));
  if (root === undefined) {
    throw new Error(`no package ${ROOT_PACKAGE} in the cargo metadata`);
  }
  const seen = new Set([root.id]);
  const queue = [root.id];
  while (queue.length > 0) {
    const node = nodes.get(queue.pop());
    for (const dep of node?.deps ?? []) {
      const normal = dep.dep_kinds.some((kind) => kind.kind === null);
      if (normal && !seen.has(dep.pkg)) {
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }
  return [...seen]
    .filter((id) => !members.has(id))
    .map((id) => byId.get(id))
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? pkg.license_file ?? "unknown",
      source: "rust",
    }));
}

/** The npm packages of the lock file that are not dev-only. */
export function fromPackageLock(lock) {
  const found = [];
  for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
    if (path === "" || pkg.dev === true) {
      continue;
    }
    const name = pkg.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    found.push({
      name,
      version: pkg.version ?? "unknown",
      license: typeof pkg.license === "string" ? pkg.license : "unknown",
      source: "npm",
    });
  }
  return found;
}

/** Sorted by name, one entry per source, name and version. */
export function merge(...lists) {
  const seen = new Set();
  const all = [];
  for (const entry of lists.flat()) {
    const key = `${entry.source}:${entry.name}@${entry.version}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(entry);
    }
  }
  return all.sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en") ||
      a.source.localeCompare(b.source) ||
      a.version.localeCompare(b.version, "en", { numeric: true }),
  );
}

function cargoMetadata() {
  const text = execFileSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--manifest-path",
      resolve(repoRoot, "Cargo.toml"),
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(text);
}

export function collect() {
  const lock = JSON.parse(readFileSync(resolve(uiRoot, "package-lock.json"), "utf8"));
  return merge(fromCargoMetadata(cargoMetadata()), fromPackageLock(lock));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = collect();
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(entries)}\n`);
  const rust = entries.filter((entry) => entry.source === "rust").length;
  process.stdout.write(
    `third-party licenses: ${rust} Rust crates, ${entries.length - rust} npm packages\n`,
  );
}
