// Tests npm-audit.mjs without the registry: npm audit reports, lockfiles and published versions
// are given as data.
//
//   node --test .github/scripts/npm-audit.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { judge, newer } from "./npm-audit.mjs";

const IGNORES = [{ id: "GHSA-aaaa-bbbb-cccc", package: "globber", newest: "4.0.7" }];

function advisory(name, id, severity = "high") {
  return {
    name,
    severity,
    range: "<=4.0.7",
    title: `${name} is affected`,
    url: `https://github.com/advisories/${id}`,
  };
}

// globber is affected, and a build tool depends on it, as `npm audit --json` reports it.
function report(...advisories) {
  const vulnerabilities = {};
  for (const a of advisories) {
    vulnerabilities[a.name] = { name: a.name, severity: a.severity, via: [a] };
  }
  vulnerabilities.bundler = { name: "bundler", severity: "high", via: advisories.map((a) => a.name) };
  return { vulnerabilities, metadata: {} };
}

const devLock = {
  packages: {
    "": {},
    "node_modules/globber": { version: "4.0.7", dev: true },
    "node_modules/bundler/node_modules/globber": { version: "4.0.6", dev: true },
  },
};
const released = () => ["4.0.6", "4.0.7"];

test("the ignored advisory passes while it is a development dependency and no newer release exists", () => {
  const verdict = judge(report(advisory("globber", "GHSA-aaaa-bbbb-cccc")), devLock, released, IGNORES);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ignored.length, 1);
});

test("another advisory on the same package still fails", () => {
  const verdict = judge(report(advisory("globber", "GHSA-zzzz-zzzz-zzzz")), devLock, released, IGNORES);
  assert.equal(verdict.errors.length, 1);
  assert.equal(verdict.ignored.length, 0);
});

test("the same advisory id on another package still fails", () => {
  const lock = { packages: { "node_modules/other": { version: "1.0.0", dev: true } } };
  const verdict = judge(report(advisory("other", "GHSA-aaaa-bbbb-cccc")), lock, released, IGNORES);
  assert.equal(verdict.errors.length, 1);
});

test("the ignore lapses once a newer release exists, a pre-release included", () => {
  for (const later of ["4.0.8", "4.1.0", "5.0.0", "4.0.8-beta.1"]) {
    const verdict = judge(
      report(advisory("globber", "GHSA-aaaa-bbbb-cccc")),
      devLock,
      () => ["4.0.7", later],
      IGNORES,
    );
    assert.equal(verdict.errors.length, 1, later);
    assert.match(verdict.errors[0], new RegExp(`${later.replaceAll(".", "\\.")} is out`));
  }
});

test("the ignore lapses when any copy is a runtime or optional dependency", () => {
  for (const entry of [{}, { devOptional: true }, { optional: true }]) {
    const lock = structuredClone(devLock);
    lock.packages["node_modules/bundler/node_modules/globber"] = { version: "4.0.6", ...entry };
    const verdict = judge(report(advisory("globber", "GHSA-aaaa-bbbb-cccc")), lock, released, IGNORES);
    assert.equal(verdict.errors.length, 1, JSON.stringify(entry));
    assert.match(verdict.errors[0], /not one here/);
  }
});

test("moderate and low advisories do not fail, as with --audit-level=high", () => {
  const verdict = judge(
    report(advisory("lexer", "GHSA-mmmm-mmmm-mmmm", "moderate"), advisory("dot", "GHSA-llll-llll-llll", "low")),
    devLock,
    released,
    IGNORES,
  );
  assert.deepEqual(verdict, { errors: [], ignored: [] });
});

test("critical advisories fail", () => {
  const verdict = judge(report(advisory("lexer", "GHSA-cccc-cccc-cccc", "critical")), devLock, released, IGNORES);
  assert.equal(verdict.errors.length, 1);
});

test("the published versions are asked only for an ignored advisory", () => {
  let asked = 0;
  judge(report(advisory("lexer", "GHSA-cccc-cccc-cccc")), devLock, () => {
    asked++;
    return [];
  }, IGNORES);
  assert.equal(asked, 0);
});

test("newer compares major, minor and patch", () => {
  assert.equal(newer("4.0.8", "4.0.7"), true);
  assert.equal(newer("4.0.7", "4.0.7"), false);
  assert.equal(newer("4.0.7-rc.1", "4.0.7"), false);
  assert.equal(newer("3.9.9", "4.0.7"), false);
  assert.equal(newer("10.0.0", "4.0.7"), true);
});
