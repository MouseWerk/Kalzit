import { describe, expect, it } from "vitest";
import { allInfra, classifyJob, cleanLog } from "../src/ci/classify.ts";

const ts = (line: string) => `2026-10-30T12:00:00.1234567Z ${line}`;
const log = (...lines: string[]) => lines.map(ts).join("\n");
const steps = (failed?: string) => [
  { name: "Set up job", conclusion: "success" },
  { name: "Run tests", conclusion: failed === "Run tests" ? "failure" : "success" },
  {
    name: "Initialize containers",
    conclusion: failed === "Initialize containers" ? "failure" : "success",
  },
];

describe("cleanLog", () => {
  it("drops GitHub timestamps and color codes", () => {
    expect(cleanLog(ts("\u001b[31mtest a ... FAILED\u001b[0m"))).toEqual(["test a ... FAILED"]);
  });
});

describe("classifyJob on `gh run view --log` output", () => {
  it("reads lines with job and step names before the timestamp, and skips runner markup", () => {
    const line = (text: string) => `e2e (ubuntu-latest)\tRun npm run e2e\t${ts(text)}`;
    const c = classifyJob({
      name: "e2e (ubuntu-latest)",
      conclusion: "failure",
      steps: steps("Run tests"),
      log: [
        "e2e (ubuntu-latest)\tSet up\t2026-10-31T18:33:10.9342556Z ##[start-action display=Work around spurious network errors;id=x]",
        line("  ✘  112 [chromium] › e2e/editor-csp.spec.ts:113:3 › an expected failure (1.7s)"),
        line("  1) [chromium] › e2e/graph.spec.ts:184:3 › Neo4j › explorer mode "),
        line("  1 failed"),
        line("  287 passed (4.6m)"),
      ].join("\n"),
    });
    expect(c.category).toBe("code");
    expect(c.failingTests).toEqual([
      "[chromium] › e2e/graph.spec.ts:184:3 › Neo4j › explorer mode",
    ]);
    expect(c.reasons.join(" ")).not.toMatch(/download|network/);
  });
});

describe("classifyJob", () => {
  it("names failing cargo tests and their assertions as a code failure", () => {
    const c = classifyJob({
      name: "server (ubuntu-latest)",
      conclusion: "failure",
      steps: steps("Run tests"),
      log: log(
        "running 12 tests",
        "test api::dashboards::saves ... FAILED",
        "---- api::dashboards::saves stdout ----",
        "thread 'api::dashboards::saves' panicked at server/tests/api.rs:88:5:",
        "assertion `left == right` failed",
        "  left: 409",
        " right: 200",
        "test result: FAILED. 11 passed; 1 failed",
      ),
    });
    expect(c.category).toBe("code");
    expect(c.failingTests).toEqual(["api::dashboards::saves"]);
    expect(c.assertions).toContain("left: 409");
    expect(c.failedSteps).toEqual(["Run tests"]);
  });

  it("names failing Playwright and vitest tests", () => {
    const c = classifyJob({
      name: "e2e (windows-latest)",
      conclusion: "failure",
      steps: steps("Run tests"),
      log: log(
        "  1) [chromium] › graph.spec.ts:41:3 › a network panel shows the shop",
        "    Error: expect(locator).toBeVisible() failed",
        " FAIL  src/panels/viz.test.tsx > bar > draws the bars",
        "  1 failed",
      ),
    });
    expect(c.category).toBe("code");
    expect(c.failingTests).toEqual([
      "[chromium] › graph.spec.ts:41:3 › a network panel shows the shop",
      "src/panels/viz.test.tsx > bar > draws the bars",
    ]);
  });

  it("takes a service container port bind error as a runner fault, even with failing tests", () => {
    const c = classifyJob({
      name: "datasources",
      conclusion: "failure",
      steps: steps("Initialize containers"),
      log: log(
        "docker: Error response from daemon: driver failed programming external connectivity on endpoint mongo: Bind for 0.0.0.0:27017 failed: port is already allocated.",
        "test mongodb::reads ... FAILED",
      ),
    });
    expect(c.category).toBe("infra");
    expect(c.reasons[0]).toMatch(/could not bind its port/);
  });

  it("takes a failed job without a failed step as a runner fault", () => {
    const c = classifyJob({ name: "ui (windows-latest)", conclusion: "failure", steps: steps() });
    expect(c.category).toBe("infra");
    expect(c.reasons).toEqual(["the job failed without a failed step"]);
  });

  it("takes network and download errors without test failures as runner faults", () => {
    for (const line of [
      "npm error code ECONNRESET",
      "error: failed to download from `https://static.crates.io/crates/serde/1.0.0/download`",
      "curl: (6) Could not resolve host: github.com",
      "The requested URL returned error: 503",
    ]) {
      const c = classifyJob({
        name: "x",
        conclusion: "failure",
        steps: steps("Run tests"),
        log: log(line),
      });
      expect(c.category, line).toBe("infra");
    }
  });

  it("keeps a code failure when a network error shows up beside failing tests", () => {
    const c = classifyJob({
      name: "x",
      conclusion: "failure",
      steps: steps("Run tests"),
      log: log("socket hang up", "test sso::login ... FAILED"),
    });
    expect(c.category).toBe("code");
    expect(c.reasons.at(-1)).toMatch(/also seen/);
  });

  it("takes compiler and type errors as code failures", () => {
    expect(
      classifyJob({
        name: "x",
        conclusion: "failure",
        steps: steps("Run tests"),
        log: log("error[E0308]: mismatched types"),
      }).category,
    ).toBe("code");
    expect(
      classifyJob({
        name: "x",
        conclusion: "failure",
        steps: steps("Run tests"),
        log: log("src/a.ts(3,1): error TS2322: no"),
      }).category,
    ).toBe("code");
  });

  it("says unknown when the log is missing and a step failed", () => {
    const c = classifyJob({ name: "x", conclusion: "failure", steps: steps("Run tests") });
    expect(c.category).toBe("unknown");
    expect(c.reasons).toEqual(["the log could not be fetched"]);
  });

  it("reports cancelled jobs as cancelled", () => {
    expect(classifyJob({ name: "x", conclusion: "cancelled" }).category).toBe("cancelled");
  });
});

describe("allInfra", () => {
  it("is true only for a non-empty set of runner faults", () => {
    const infra = classifyJob({ name: "x", conclusion: "failure", steps: steps() });
    const code = classifyJob({
      name: "y",
      conclusion: "failure",
      steps: steps("Run tests"),
      log: log("test a ... FAILED"),
    });
    expect(allInfra([infra])).toBe(true);
    expect(allInfra([infra, code])).toBe(false);
    expect(allInfra([])).toBe(false);
  });
});
