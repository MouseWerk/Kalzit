import { z } from "zod";
import { affectedTests } from "./affected.ts";
import { captureScreens, SCENE_NAMES } from "./capture.ts";
import { ciFailures, ciStatus } from "./ci/ci.ts";
import { mergePr } from "./ci/merge.ts";
import { visualDiff } from "./diff.ts";
import { listInstances, startInstance, stopInstance } from "./instance/manager.ts";
import { uiCheck } from "./uicheck.ts";

/**
 * Every tool once: its input schema, what it does, and how. The MCP server registers these as
 * tools; the CLI offers each as a subcommand with the same options.
 */
export interface ToolContext {
  /** Progress for a person (stderr in the CLI, nothing in the MCP server). Never credentials. */
  log: (line: string) => void;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: S;
  /** Options the CLI also takes as positional arguments, in order. */
  positional?: (keyof S & string)[];
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

function tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const locales = z.array(z.enum(["en", "de"])).optional();
const themes = z.array(z.enum(["light", "dark", "contrast"])).optional();
const widths = z.array(z.number().int().min(320).max(3840)).optional();
const instanceId = z.string().optional().describe("Instance id; default the newest running one");
const screens = z
  .array(z.string())
  .optional()
  .describe("Screen names (see README) or paths starting with /; default all main screens");
const repo = z.string().optional().describe("owner/name, default MouseWerk/Kalzit");

export const TOOLS = [
  tool({
    name: "instance_start",
    description:
      "Start a Kalzit server for UI work: builds the server once (or reuses the build), starts it on a random free port (never 3000) with its own run and data folder, seeds the README demo organization, optionally a Neo4j graph (own container) and the fake AI provider. Returns the URL and the generated credentials (kept only in the run folder). Stopped with instance_stop, and when the starting process ends unless detached.",
    shape: {
      graph: z
        .boolean()
        .optional()
        .describe("Start a Neo4j container seeded with graph-shop.cypher"),
      ai: z.boolean().optional().describe("Start the fake AI provider and turn AI on"),
      seed: z.boolean().optional().describe("Seed the README demo data (default true)"),
      fixedClock: z
        .boolean()
        .optional()
        .describe(
          "Fixture data around the README screenshot moment (default true); false: around now",
        ),
      detached: z.boolean().optional().describe("Keep running after this process ends"),
      binary: z.string().optional().describe("Use this server binary instead of building"),
      rebuild: z.boolean().optional().describe("Build even when a binary exists"),
      profile: z.enum(["e2e", "release"]).optional().describe("Cargo profile (default e2e)"),
      showCredentials: z
        .boolean()
        .optional()
        .describe("Also return the passwords; by default only the owner's email and the file"),
    },
    run: async (args, ctx) => {
      const { showCredentials, ...options } = stripUndefined(args);
      const result = await startInstance({ ...options, log: ctx.log });
      return {
        id: result.instance.id,
        url: result.instance.url,
        owner: result.credentials.owner?.email,
        ...(showCredentials === true ? { credentials: result.credentials } : {}),
        credentialsFile: result.credentialsPath,
        runDir: result.instance.runDir,
        serverLog: result.instance.logPath,
        detached: result.instance.detached,
        seed: result.instance.seed,
        fixedNow: result.instance.fixedNow,
      };
    },
  }),
  tool({
    name: "instance_stop",
    description:
      "Stop an instance started by instance_start (by id, or 'all'): ends only the processes and containers it started, by PID and container id, and removes its run folder.",
    shape: { id: z.string().describe("Instance id or 'all'") },
    positional: ["id"],
    run: async (args) => ({ stopped: await stopInstance(args.id) }),
  }),
  tool({
    name: "instance_list",
    description:
      "List the instances started by instance_start that still run (stale ones are cleaned up).",
    shape: {},
    run: async () =>
      listInstances().map((i) => ({
        id: i.id,
        url: i.url,
        running: i.running,
        detached: i.detached,
        createdAt: i.createdAt,
        graph: i.seed?.graph !== undefined,
        ai: i.seed?.ai !== undefined,
        credentialsFile: `${i.runDir}/credentials.json`,
      })),
  }),
  tool({
    name: "capture_screens",
    description: `Screenshot screens of a running instance with Playwright across locales, themes and widths into a folder, and/or run existing shots scenes (${SCENE_NAMES.join(", ")}) through the e2e harness. Returns a manifest with the paths.`,
    shape: {
      instance: instanceId,
      screens,
      locales: locales.describe("Default en and de"),
      themes: themes.describe("Default light and dark"),
      widths: widths.describe("Default 1440 and 1024"),
      height: z.number().int().optional(),
      fullPage: z.boolean().optional(),
      out: z
        .string()
        .optional()
        .describe("Output folder; default tools/devkit/.out/captures/<time>"),
      scenes: z
        .array(z.string())
        .optional()
        .describe(`Shots scenes: ${SCENE_NAMES.join(", ")}`),
    },
    run: (args) => captureScreens(stripUndefined(args)),
  }),
  tool({
    name: "visual_diff",
    description:
      "Compare two capture folders (before/after, main/branch): per-image diff images, a changed-pixels score, and an HTML and Markdown report listing the changed screens. threshold ignores anti-aliasing noise.",
    shape: {
      before: z.string(),
      after: z.string(),
      out: z.string().optional(),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Per-pixel color threshold (default 0.1)"),
      minScore: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Share of changed pixels that still counts as unchanged (default 0.0005)"),
    },
    positional: ["before", "after"],
    run: async (args) => {
      const report = visualDiff(stripUndefined(args));
      return { ...report, entries: report.entries.filter((e) => e.status !== "unchanged") };
    },
  }),
  tool({
    name: "ui_check",
    description:
      "Find UI defects on a running instance: axe accessibility violations, horizontal overflow, clipped text and console errors, per screen, locale, theme and width. Returns findings with selectors.",
    shape: {
      instance: instanceId,
      screens,
      locales: locales.describe("Default en"),
      themes: themes.describe("Default light"),
      widths: widths.describe("Default 1440 and 1024"),
      checks: z.array(z.enum(["axe", "overflow", "clipped", "console"])).optional(),
      impacts: z.array(z.enum(["minor", "moderate", "serious", "critical"])).optional(),
    },
    run: (args) => uiCheck(stripUndefined(args)),
  }),
  tool({
    name: "ci_status",
    description: "Summarise the checks of a pull request, a workflow run or a commit.",
    shape: {
      pr: z.number().int().optional(),
      run: z.number().int().optional(),
      sha: z.string().optional(),
      repo,
    },
    positional: ["pr"],
    run: async (args) => {
      const status = await ciStatus(stripUndefined(args));
      return { ...status, checks: undefined };
    },
  }),
  tool({
    name: "ci_failures",
    description:
      "For the failed checks of a PR, run or commit: fetch the job logs through the API (with fallbacks when they are missing), extract failing tests and assertion lines, and classify each job as code failure or runner/infra fault.",
    shape: {
      pr: z.number().int().optional(),
      run: z.number().int().optional(),
      sha: z.string().optional(),
      repo,
    },
    positional: ["pr"],
    run: (args) => ciFailures(stripUndefined(args)),
  }),
  tool({
    name: "merge_pr",
    description:
      "Merge a PR through the merge queue: wait for its checks (rerun failed jobs once when all are runner faults), enqueue, wait until merged; re-enqueue once after a merge-group runner fault; stop on DIRTY or real failures. Can take long; from an agent prefer the CLI in the background.",
    shape: {
      pr: z.number().int(),
      repo,
      timeoutMinutes: z.number().int().optional(),
      pollSeconds: z.number().int().min(5).optional(),
      deleteBranch: z.boolean().optional(),
    },
    positional: ["pr"],
    run: (args, ctx) => mergePr({ ...stripUndefined(args), log: ctx.log }),
  }),
  tool({
    name: "affected_tests",
    description:
      "Suggest the targeted test commands for a diff (default the branch against origin/main plus uncommitted changes): cargo test files and filters, vitest files and Playwright specs. Optionally run them with the load limits (CARGO_BUILD_JOBS=2, vitest --maxWorkers=2, Playwright --workers=2).",
    shape: {
      base: z.string().optional(),
      includeWorkingTree: z.boolean().optional(),
      paths: z.array(z.string()).optional().describe("Map these paths instead of a diff"),
      run: z.boolean().optional(),
    },
    run: (args) => affectedTests(stripUndefined(args)),
  }),
] as const;

/** Drops undefined values, for options typed with exactOptionalPropertyTypes. */
export function stripUndefined<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
