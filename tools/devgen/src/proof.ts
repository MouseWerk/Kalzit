import { existsSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { i18nCheck } from "./lib/i18n.ts";
import { git, repoRoot, run } from "./lib/repo.ts";
import { type RouteRequest, scaffoldRoute } from "./lib/routeScaffold.ts";
import { type SettingRequest, scaffoldSetting } from "./lib/settingScaffold.ts";

/**
 * The proof that the generators' output passes the repository's own checks out of the box:
 * scaffolds routes (new module, existing module, session-only route, new error code, reason with
 * UI texts) and settings (whole number, choice in a reasons namespace, organization bool) into a
 * temporary worktree, or into this checkout with --in-place (CI), then runs cargo fmt, clippy,
 * the generated and affected server tests, Biome, the typecheck and the affected UI tests.
 */

export const PROOF_ROUTES: RouteRequest[] = [
  {
    module: "devgen_proof",
    method: "POST",
    path: "/orgs/{orgId}/devgen-proof/{itemId}",
    access: "dashboards:write",
    handler: "rename_item",
    summary: "Renames a proof item",
    docs: "dashboard-features.md",
    title: "Generator proof",
    reason: "devgen_proof.name_missing",
    reasonEn: "Enter a name.",
    reasonDe: "Gib einen Namen ein.",
    reasonDocs: "datasources.md",
  },
  {
    module: "devgen_proof",
    method: "POST",
    path: "/orgs/{orgId}/devgen-proof",
    access: "OrgMember",
    handler: "claim_item",
    summary: "Claims a proof item for the caller",
    docs: "dashboard-features.md",
    errorCode: "devgen_proof_taken",
    errorStatus: 409,
    errorEn: "Someone else took this item first.",
    errorDe: "Jemand anderes hat diesen Eintrag zuerst genommen.",
  },
  {
    module: "usage",
    method: "GET",
    path: "/admin/devgen-proof",
    access: "ServerAdmin",
    handler: "proof_status",
    summary: "Answers the proof status for server administrators",
    docs: "usage.md",
  },
  {
    module: "me",
    method: "GET",
    path: "/me/devgen-proof",
    access: "Authenticated",
    handler: "own_proof",
    summary: "Answers the caller’s own proof",
    docs: "access.md",
  },
];

export const PROOF_SETTINGS: SettingRequest[] = [
  {
    key: "audit.devgen_proof_days",
    scope: "server",
    type: "int",
    default: "30",
    min: 1,
    max: 3650,
    description: "Days the generator proof keeps its entries.",
    labelEn: "Proof entries kept",
    labelDe: "Aufbewahrung der Probeeinträge",
    descriptionEn: "Days before proof entries are deleted.",
    descriptionDe: "Tage, bis Probeeinträge gelöscht werden.",
    section: "storage",
    keywordsEn: "proof",
    keywordsDe: "probe",
  },
  {
    key: "updates.devgen_proof_mode",
    scope: "server",
    type: "choice",
    default: "calm",
    choices: ["calm", "eager"],
    choiceEn: ["Calm", "Eager"],
    choiceDe: ["Ruhig", "Eifrig"],
    description: "How eagerly the generator proof acts.",
    labelEn: "Proof mode",
    labelDe: "Probemodus",
    descriptionEn: "How eagerly proof entries are handled.",
    descriptionDe: "Wie eifrig Probeeinträge behandelt werden.",
    section: "general",
  },
  {
    key: "dashboards.devgen_proof_enabled",
    scope: "org",
    type: "bool",
    default: "false",
    description: "Turns the generator proof on for the organization.",
    labelEn: "Proof in this organization",
    labelDe: "Probe in dieser Organisation",
    descriptionEn: "Shows proof entries to members of this organization.",
    descriptionDe: "Zeigt Mitgliedern dieser Organisation Probeeinträge.",
    section: "organization",
  },
];

/** The script file of a package's bin, run with this Node (no shell, works on Windows). */
function nodeBin(packageDir: string, name: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
  if (bin === undefined) {
    throw new Error(`${packageDir} has no bin ${name}`);
  }
  return join(packageDir, bin);
}

interface Step {
  name: string;
  cmd: string;
  args: string[];
  cwd: string;
}

export async function proof(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "in-place": { type: "boolean" },
      keep: { type: "boolean" },
      "skip-cargo": { type: "boolean" },
      "skip-ui": { type: "boolean" },
    },
    strict: true,
  });
  const source = repoRoot();
  let target = source;
  let worktree: string | undefined;
  if (values["in-place"] !== true) {
    worktree = join(mkdtempSync(join(tmpdir(), "kalzit-devgen-proof-")), "repo");
    const added = git(source, "worktree", "add", "--detach", worktree, "HEAD");
    if (!added.ok) {
      throw new Error(`git worktree add failed: ${added.stderr}`);
    }
    target = worktree;
    // The UI's packages from this checkout, so the proof needs no npm ci.
    const modules = join(source, "ui", "node_modules");
    if (existsSync(modules)) {
      symlinkSync(modules, join(target, "ui", "node_modules"), "junction");
    }
  }
  const log = (line: string) => process.stdout.write(`${line}\n`);
  let failed = 0;
  try {
    log(`Scaffolding into ${target}`);
    for (const request of PROOF_ROUTES) {
      const result = scaffoldRoute(target, request);
      log(
        `route ${request.method} ${request.path}: ${[...result.created, ...result.changed].length} files${result.warnings.length > 0 ? `; ${result.warnings.join("; ")}` : ""}`,
      );
    }
    for (const request of PROOF_SETTINGS) {
      const result = scaffoldSetting(target, request);
      log(
        `setting ${request.key}: ${[...result.created, ...result.changed].length} files${result.warnings.length > 0 ? `; ${result.warnings.join("; ")}` : ""}`,
      );
    }
    const i18n = i18nCheck(target);
    if (i18n.errors.length > 0) {
      failed++;
      log(`FAIL devgen i18n_check:\n${i18n.errors.join("\n")}`);
    } else {
      log("ok   devgen i18n_check");
    }
    const steps: Step[] = [];
    if (values["skip-cargo"] !== true) {
      const routeTests = PROOF_ROUTES.flatMap((r) => ["--test", `${r.module}_${r.handler}`]);
      const settingTests = PROOF_SETTINGS.flatMap((s) => [
        "--test",
        `setting_${s.key.replace(/\./g, "_")}`,
      ]);
      steps.push(
        { name: "cargo fmt", cmd: "cargo", args: ["fmt", "--all", "--check"], cwd: target },
        {
          name: "cargo clippy",
          cmd: "cargo",
          args: ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"],
          cwd: target,
        },
        {
          name: "generated server tests",
          cmd: "cargo",
          args: ["test", "--locked", ...routeTests, ...settingTests],
          cwd: target,
        },
        {
          name: "affected server tests",
          cmd: "cargo",
          args: [
            "test",
            "--locked",
            "--lib",
            "--",
            "settings::",
            "routes::",
            "datasources::detail",
            "shapes::",
          ],
          cwd: target,
        },
        {
          name: "every route enforces its access",
          cmd: "cargo",
          args: ["test", "--locked", "--test", "api", "every_declared_route_enforces_its_access"],
          cwd: target,
        },
      );
    }
    if (values["skip-ui"] !== true) {
      const ui = join(target, "ui");
      const modules = join(ui, "node_modules");
      if (!existsSync(modules)) {
        throw new Error("ui/node_modules is missing; run npm ci in ui first");
      }
      steps.push(
        {
          name: "biome",
          cmd: process.execPath,
          args: [
            nodeBin(join(modules, "@biomejs", "biome"), "biome"),
            "check",
            "--error-on-warnings",
            ".",
          ],
          cwd: ui,
        },
        {
          name: "typecheck",
          cmd: process.execPath,
          args: [nodeBin(join(modules, "typescript"), "tsc"), "-p", "tsconfig.json"],
          cwd: ui,
        },
        {
          name: "affected UI tests",
          cmd: process.execPath,
          args: [
            nodeBin(join(modules, "vitest"), "vitest"),
            "run",
            "src/i18n",
            "src/features/settings",
            "src/features/admin/settingTexts.test.ts",
            "src/features/datasources/reasons.test.ts",
          ],
          cwd: ui,
        },
      );
    }
    for (const step of steps) {
      const started = Date.now();
      const result = run(step.cmd, step.args, step.cwd);
      const secs = Math.round((Date.now() - started) / 1000);
      if (result.ok) {
        log(`ok   ${step.name} (${secs} s)`);
      } else {
        failed++;
        log(
          `FAIL ${step.name} (${secs} s)\n${(result.stdout + result.stderr).trim().split("\n").slice(-60).join("\n")}`,
        );
      }
    }
  } finally {
    if (worktree !== undefined && values.keep !== true) {
      // The link to the UI's packages goes first, so removing the worktree cannot reach them.
      const link = join(worktree, "ui", "node_modules");
      if (existsSync(link)) {
        if (process.platform === "win32") {
          rmdirSync(link);
        } else {
          unlinkSync(link);
        }
      }
      git(source, "worktree", "remove", "--force", worktree);
    } else if (worktree !== undefined) {
      log(`kept ${worktree}; remove it with git worktree remove --force`);
    }
  }
  log(failed === 0 ? "Proof passed." : `Proof failed: ${failed} step(s).`);
  return failed === 0 ? 0 : 1;
}
