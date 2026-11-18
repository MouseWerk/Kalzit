// npm audit for one lockfile directory, with ignores that each carry their reason: the npm
// counterpart of .cargo/audit.toml. Used by ci.yml (job `audit`) and audit-nightly.yml; tested by
// npm-audit.test.mjs.
//
//   node .github/scripts/npm-audit.mjs <directory with package-lock.json>
//
// Fails on every high or critical advisory that is not ignored below, as `npm audit
// --audit-level=high` does. An ignore holds only while every copy of the package in that
// lockfile is a development dependency and while no release newer than the one named in the
// ignore exists: once one is out (likely the fix) or the package reaches the shipped code, the
// advisory fails the run again, so an ignore cannot outlive its reason. It runs on the Linux
// runners. Only the lockfile is audited; nothing is installed and no package script runs. A run
// without a report (the registry was unreachable) is tried again, so that does not read as a
// finding.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const IGNORES = [
  {
    // picomatch: ReDoS through single-branch repeated extglobs such as `+(*)` (CVE-2026-112366),
    // reviewed by GitHub on 2026-11-17. Every release is affected (<= 4.0.7) and none is fixed
    // yet; upstream fixes are open pull requests. In all three lockfiles picomatch is only a
    // development dependency of the build and test tools (vite, vitest, tinyglobby, fdir,
    // @rolldown/plugin-babel), which match globs written in this repository's own configuration.
    // It is not part of the UI bundle or the server binary, and no glob from outside reaches it.
    // Decided by the owner on 2026-11-18 (PR #327): ignore only this advisory, only while
    // picomatch is a development dependency, and only until a release newer than 4.0.7 exists.
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    newest: "4.0.7",
  },
];

const LEVELS = new Set(["high", "critical"]);

function release(version) {
  return (String(version).match(/^(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
}

/** Whether `version` has a higher major, minor or patch than `than` (a pre-release counts). */
export function newer(version, than) {
  const [a, b] = [release(version), release(than)];
  if (a.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Whether every copy of `name` in the lockfile is a development dependency only. */
export function devOnly(lock, name) {
  const entries = Object.entries(lock.packages ?? {}).filter(
    ([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
  );
  return entries.length > 0 && entries.every(([, entry]) => entry.dev === true);
}

/**
 * The verdict on one `npm audit --json` report: `errors` fail the run, `ignored` are reported.
 * `versions(name)` answers the package's published versions; it is asked only for an ignore.
 */
export function judge(report, lock, versions, ignores = IGNORES) {
  // The advisories themselves; packages that only depend on an affected one name it in `via`.
  const advisories = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || !LEVELS.has(via.severity)) continue;
      const id = String(via.url).split("/").pop();
      advisories.set(`${id} ${via.name}`, { ...via, id });
    }
  }
  const errors = [];
  const ignored = [];
  for (const advisory of advisories.values()) {
    const line = `${advisory.severity} ${advisory.name} ${advisory.range}: ${advisory.title} (${advisory.url})`;
    const ignore = ignores.find((i) => i.id === advisory.id && i.package === advisory.name);
    if (!ignore) {
      errors.push(line);
      continue;
    }
    if (!devOnly(lock, ignore.package)) {
      errors.push(`${line}; ignored only as a development dependency, but it is not one here`);
      continue;
    }
    const later = versions(ignore.package).filter((v) => newer(v, ignore.newest));
    if (later.length > 0) {
      errors.push(
        `${line}; ${ignore.package} ${later.join(", ")} is out since the ignore: update it and drop or renew the ignore`,
      );
      continue;
    }
    ignored.push(line);
  }
  return { errors, ignored };
}

function npm(args, cwd) {
  try {
    return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    // `npm audit` exits non-zero when it finds something; its report is still on stdout.
    if (typeof error.stdout === "string" && error.stdout.length > 0) return error.stdout;
    throw error;
  }
}

function audit(dir) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const report = JSON.parse(npm(["audit", "--package-lock-only", "--json"], dir));
      if (report.metadata) return report;
    } catch {
      // Unreachable registry or unreadable answer: tried again below.
    }
    console.error(`npm audit could not reach the registry (attempt ${attempt} of 3)`);
    if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 10_000);
  }
  throw new Error("npm audit could not reach the registry");
}

function main(dir) {
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  const report = audit(dir);
  const { errors, ignored } = judge(report, lock, (name) => {
    const answer = JSON.parse(npm(["view", name, "versions", "--json"], dir));
    return Array.isArray(answer) ? answer : [answer];
  });
  for (const line of ignored) console.log(`ignored, see .github/scripts/npm-audit.mjs: ${line}`);
  for (const line of errors) console.log(`::error::${line}`);
  if (errors.length > 0) process.exit(1);
  console.log(`npm audit (${dir}): no high or critical advisories besides the ignored ones`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!process.argv[2]) {
    console.error("usage: node .github/scripts/npm-audit.mjs <directory>");
    process.exit(2);
  }
  main(process.argv[2]);
}
