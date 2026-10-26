// Writes the third-party license files of the UI bundle (Settings, About):
//   public/third-party-licenses.json   name, version, license and source of every package
//   public/THIRD-PARTY-NOTICES.txt     the license texts those packages ship with
// for the Rust crates the server links on this platform and the npm packages of the UI's
// production dependency tree. `npm run build` runs it, so both land in the bundle the server
// embeds.
//
// Rust: `cargo metadata --locked --filter-platform <host or KALZIT_LICENSES_TARGET>`, following only normal dependencies
// from the `kalzit` package (build and dev dependencies are not part of the binary, and crates of
// other platforms are left out). The license files come from the crates' sources in the cargo
// registry. npm: package-lock.json, entries that are not dev-only, license files from
// node_modules.
//
// Without cargo the build does not fail: it keeps the files of an earlier run, or writes the npm
// part only, and says so. CI and release builds must not ship that: they fail hard when
// KALZIT_LICENSES_STRICT=1, or when CI is set (unless KALZIT_LICENSES_STRICT=0, for jobs that
// only check the UI).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "..");
const repoRoot = resolve(uiRoot, "..");
const LIST = resolve(uiRoot, "public", "third-party-licenses.json");
const NOTICES = resolve(uiRoot, "public", "THIRD-PARTY-NOTICES.txt");
const ROOT_PACKAGE = "kalzit";
/** What the list says for a package that has a license file instead of an SPDX expression. */
export const SEE_FILE = "SEE LICENSE FILE";
const MAX_FILE_BYTES = 256 * 1024;
const LICENSE_FILE = /^(licen[sc]e|copying|notice|unlicense|copyright)([-_. ].*)?$/i;

/** Remembers where a package's files are, without putting the path into the list. */
function withDir(entry, dir) {
  Object.defineProperty(entry, "dir", { value: dir, enumerable: false });
  return entry;
}

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
    .map((pkg) =>
      withDir(
        {
          name: pkg.name,
          version: pkg.version,
          license: pkg.license ?? SEE_FILE,
          source: "rust",
        },
        pkg.manifest_path === undefined ? undefined : dirname(pkg.manifest_path),
      ),
    );
}

/** The npm packages of the lock file that are not dev-only. */
export function fromPackageLock(lock, root = uiRoot) {
  const found = [];
  for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
    if (path === "" || pkg.dev === true) {
      continue;
    }
    const name = pkg.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const license = typeof pkg.license === "string" && pkg.license !== "" ? pkg.license : SEE_FILE;
    found.push(
      withDir(
        { name, version: pkg.version ?? "unknown", license, source: "npm" },
        resolve(root, path),
      ),
    );
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

/** Plain ASCII, so the file reads the same in every viewer: symbols spelled out, accents dropped. */
export function toAscii(text) {
  return text
    .replaceAll("©", "(c)")
    .replaceAll("®", "(R)")
    .replaceAll("™", "(TM)")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replaceAll("…", "...")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\t\n -~]/g, "?");
}

/** The license, notice and copying files in the top folder of a package. */
export function licenseFiles(dir) {
  if (dir === undefined || !existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (
      LICENSE_FILE.test(name) &&
      statSync(path).isFile() &&
      statSync(path).size <= MAX_FILE_BYTES
    ) {
      const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n").trim();
      if (text !== "") {
        files.push({ name, text });
      }
    }
  }
  return files;
}

/**
 * The notices file: every distinct license text once, with the packages it belongs to. Packages
 * that ship no license file are listed with their license expression.
 */
export function buildNotices(entries) {
  const groups = new Map();
  const without = [];
  for (const entry of entries) {
    const files = licenseFiles(entry.dir);
    if (files.length === 0) {
      without.push(entry);
      continue;
    }
    const text = files.map((file) => `${file.name}\n\n${file.text}`).join("\n\n");
    const key = createHash("sha256").update(text).digest("hex");
    const group = groups.get(key) ?? { text, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  const label = (entry) => `${entry.name} ${entry.version} (${entry.source}, ${entry.license})`;
  const rule = "=".repeat(78);
  const parts = [
    "Third-party notices for Kalzit\n\nKalzit includes the software below. Each group of packages is followed by the license\ntext those packages ship with.",
  ];
  for (const group of [...groups.values()].sort((a, b) => b.entries.length - a.entries.length)) {
    parts.push(`${rule}\n${group.entries.map(label).join("\n")}\n${rule}\n\n${group.text}`);
  }
  if (without.length > 0) {
    parts.push(
      `${rule}\nPackages that ship no license file\n${rule}\n\n${without.map(label).join("\n")}`,
    );
  }
  return toAscii(`${parts.join("\n\n")}\n`);
}

function hostTriple() {
  try {
    const text = execFileSync("rustc", ["-vV"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /^host: (.+)$/m.exec(text)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function cargoMetadata() {
  const args = ["metadata", "--format-version", "1", "--locked"];
  // A cross build (the arm64 container image built on amd64) names the platform the binary is
  // for in KALZIT_LICENSES_TARGET.
  const target = process.env.KALZIT_LICENSES_TARGET || hostTriple();
  if (target !== undefined) {
    args.push("--filter-platform", target);
  }
  args.push("--manifest-path", resolve(repoRoot, "Cargo.toml"));
  const text = execFileSync("cargo", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(text);
}

export function isStrict(env = process.env) {
  if (env.KALZIT_LICENSES_STRICT === "1") {
    return true;
  }
  return env.KALZIT_LICENSES_STRICT !== "0" && env.CI !== undefined && env.CI !== "";
}

function main() {
  const npm = fromPackageLock(
    JSON.parse(readFileSync(resolve(uiRoot, "package-lock.json"), "utf8")),
  );
  let rust;
  try {
    rust = fromCargoMetadata(cargoMetadata());
  } catch (error) {
    if (isStrict()) {
      throw error;
    }
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    if (existsSync(LIST) && existsSync(NOTICES)) {
      process.stderr.write(
        `warning: no Rust license list (${reason}); keeping the files of the last full run\n`,
      );
      return;
    }
    process.stderr.write(
      `warning: no Rust license list (${reason}); writing the npm packages only, which is not for a release\n`,
    );
    rust = [];
  }
  const entries = merge(rust, npm);
  mkdirSync(dirname(LIST), { recursive: true });
  writeFileSync(LIST, `${JSON.stringify(entries)}\n`);
  writeFileSync(NOTICES, buildNotices(entries));
  process.stdout.write(
    `third-party licenses: ${rust.length} Rust crates, ${npm.length} npm packages\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
