import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "../src/lib/repo.ts";

/** The real repository, read-only for tests. */
export const REPO = repoRoot();

/** A temporary folder with `files` written into it; removed by the returned function. */
export function tempTree(files: Record<string, string> = {}): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kalzit-devgen-test-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A copy of the repository files the scaffolds read and write, so a test can scaffold into it
 * and run the checks over the result without touching the checkout.
 */
export function scaffoldFixture(): { dir: string; done: () => void } {
  const tree = tempTree();
  const copy = (path: string) =>
    cpSync(join(REPO, path), join(tree.dir, path), { recursive: true });
  for (const path of [
    "rustfmt.toml",
    "server/src/routes",
    "server/src/authz.rs",
    "server/src/error.rs",
    "server/src/settings.rs",
    "server/src/datasources/detail.rs",
    "ui/src/api/generated/shapes.ts",
    "ui/src/api/client.ts",
    "ui/src/i18n",
    "ui/src/features/settings/sections.ts",
    "ui/src/features/settings/rows.tsx",
    "docs/api",
    "docs/glossary.md",
  ]) {
    copy(path);
  }
  mkdirSync(join(tree.dir, "server", "tests"), { recursive: true });
  mkdirSync(join(tree.dir, "server", "migrations"), { recursive: true });
  return tree;
}
