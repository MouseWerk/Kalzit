import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { directInvocation, isSafePath, mapAffected, type RepoView } from "../src/affected.ts";
import type { JobFailure } from "../src/ci/ci.ts";
import { classifyJob } from "../src/ci/classify.ts";
import { rerunnable } from "../src/ci/merge.ts";
import { sameDir } from "../src/instance/manager.ts";

const ts = (line: string) => `2026-10-30T12:00:00.1234567Z ${line}`;

describe("timeouts and cancellations are never runner faults", () => {
  it("takes a job that hit its time limit as unknown, not infra", () => {
    const c = classifyJob({
      name: "e2e (windows-latest)",
      conclusion: "failure",
      steps: [
        { name: "Set up job", conclusion: "success" },
        { name: "Run npm run e2e", conclusion: "cancelled" },
      ],
      log: ts(
        "##[error]The job running on runner X has exceeded the maximum execution time of 60 minutes.",
      ),
    });
    expect(c.category).toBe("unknown");
    expect(c.reasons[0]).toMatch(/time limit/);
  });

  it("takes the annotation alone as a time limit too", () => {
    const c = classifyJob({
      name: "server",
      conclusion: "failure",
      steps: [{ name: "Test", conclusion: "success" }],
      log: ts("##[error]The job has exceeded the maximum execution time of 45m0s"),
    });
    expect(c.category).toBe("unknown");
  });

  it("does not rerun cancelled, unknown or code failures", () => {
    const failure = (category: JobFailure["category"]) =>
      ({
        category,
        reasons: [],
        failedSteps: [],
        failingTests: [],
        assertions: [],
      }) as unknown as JobFailure;
    expect(rerunnable([failure("infra")])).toBe(true);
    expect(rerunnable([failure("infra"), failure("cancelled")])).toBe(false);
    expect(rerunnable([failure("unknown")])).toBe(false);
    expect(rerunnable([])).toBe(false);
  });
});

describe("weak network signs in steps that run the product", () => {
  it("takes a reset connection in a smoke or package step as unknown", () => {
    for (const step of [
      "Smoke test the image",
      "docker",
      "Package and check health",
      "msi install",
    ]) {
      const c = classifyJob({
        name: "packages",
        conclusion: "failure",
        steps: [{ name: step, conclusion: "failure" }],
        log: ts("curl: (56) Recv failure: Connection reset by peer"),
      });
      expect(c.category, step).toBe("unknown");
      expect(c.reasons[0]).toMatch(/could be a crash/);
    }
  });

  it("still takes it as infra in a dependency step", () => {
    const c = classifyJob({
      name: "ui",
      conclusion: "failure",
      steps: [{ name: "Run npm ci", conclusion: "failure" }],
      log: ts("npm error code ECONNRESET"),
    });
    expect(c.category).toBe("infra");
  });
});

describe("affected_tests input safety", () => {
  const files = ["ui/e2e/graph.spec.ts", "ui/src/a.test.ts", "ui/src/a.ts"];
  const repo: RepoView = { files: [...files, "ui/src/$(evil).test.ts"], read: () => "" };

  it("accepts only plain repository paths", () => {
    expect(isSafePath("ui/src/a.ts")).toBe(true);
    for (const bad of [
      "ui/src/a b.ts",
      "ui/src/$(x).ts",
      "a;rm -rf x",
      "-flag",
      "../x",
      "ui/`x`.ts",
      'ui/"x".ts',
    ]) {
      expect(isSafePath(bad), bad).toBe(false);
    }
  });

  it("never passes a crafted path to a command, and reports it", () => {
    const result = mapAffected(
      ["ui/src/$(evil).test.ts", "ui/e2e/x;y.spec.ts", "ui/src/a.ts"],
      repo,
    );
    const args = result.commands.flatMap((c) => c.args);
    expect(args.some((a) => a.includes("$") || a.includes(";"))).toBe(false);
    expect(result.uncovered).toEqual(["ui/src/$(evil).test.ts", "ui/e2e/x;y.spec.ts"]);
  });

  it("passes a changed spec or test only when the repository tracks it", () => {
    const result = mapAffected(["ui/e2e/deleted.spec.ts", "ui/src/deleted.test.ts"], repo);
    expect(result.commands.flatMap((c) => c.args).join(" ")).not.toMatch(/deleted/);
  });

  it("runs npx commands as node with the package script, without a shell", () => {
    const [vitest] = mapAffected(["ui/src/a.test.ts"], repo).commands;
    if (vitest === undefined) throw new Error("no command");
    const direct = directInvocation(vitest, "/repo");
    expect(direct.command).toBe(process.execPath);
    expect(direct.args[0]).toBe(join("/repo", "ui", "node_modules/vitest/vitest.mjs"));
    expect(direct.args.slice(1)).toEqual(["run", "--maxWorkers=2", "src/a.test.ts"]);
  });
});

describe("instance state trust", () => {
  it("compares run folders by their resolved path", () => {
    const dir = resolve("x", "inst-a");
    expect(sameDir(join("x", "inst-a"), dir)).toBe(true);
    expect(sameDir(join("x", "inst-a", "..", "..", "other"), dir)).toBe(false);
    expect(sameDir(resolve("elsewhere"), dir)).toBe(false);
  });
});
