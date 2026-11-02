import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Forge } from "./forge.ts";
import { writeText } from "./repo.ts";

/**
 * Migration numbers (`server/migrations/00NN_name.sql`). Two open pull requests took the same
 * number three times; the next free number therefore counts main, this checkout and every open
 * pull request.
 */

export const MIGRATIONS_DIR = "server/migrations";
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Taken {
  number: number;
  file: string;
  /** "main", "checkout" or "#<pr> <branch>". */
  where: string;
}

function parse(file: string): { number: number; name: string } | undefined {
  const match = FILE.exec(file);
  return match === null ? undefined : { number: Number(match[1]), name: match[2] ?? "" };
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Every migration number in use on main, in this checkout and in open pull requests. */
export function takenMigrations(
  root: string,
  forge: Forge,
  options: { excludeBranch?: string } = {},
): Taken[] {
  const taken: Taken[] = [];
  for (const file of forge.mainFiles(MIGRATIONS_DIR)) {
    if (parse(file) !== undefined) {
      taken.push({ number: parse(file)?.number ?? 0, file, where: "main" });
    }
  }
  const dir = join(root, MIGRATIONS_DIR);
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      const parsed = parse(file);
      if (parsed !== undefined && !taken.some((t) => t.file === file && t.where === "main")) {
        taken.push({ number: parsed.number, file, where: "checkout" });
      }
    }
  }
  for (const pr of forge.openPullRequests()) {
    if (options.excludeBranch !== undefined && pr.headRefName === options.excludeBranch) {
      continue;
    }
    for (const path of pr.files) {
      if (!path.startsWith(`${MIGRATIONS_DIR}/`)) {
        continue;
      }
      const file = baseName(path);
      const parsed = parse(file);
      if (parsed !== undefined) {
        taken.push({ number: parsed.number, file, where: `#${pr.number} ${pr.headRefName}` });
      }
    }
  }
  return taken;
}

export interface NextMigration {
  number: number;
  /** Four digits, as in the file name. */
  padded: string;
  /** The created file, relative to the repository root, when `create` was asked for. */
  created?: string;
  /** The highest numbers in use and where, newest first. */
  newest: Taken[];
  warnings: string[];
}

export function pad(number: number): string {
  return String(number).padStart(4, "0");
}

/** A file name part: lower case, digits and underscores. */
export function migrationName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned === "") {
    throw new Error("the migration needs a name of letters or digits, such as sign_ins");
  }
  return cleaned;
}

export function migrationHeader(description: string): string {
  const text = description.trim().replace(/\s+/g, " ");
  const wrapped = wrap(text === "" ? "TODO: what this migration changes and why." : text, 97);
  return [
    ...wrapped.map((line) => `-- ${line}`),
    "-- Portable SQL only: the same file runs on SQLite and PostgreSQL (server/src/db.rs).",
    "",
  ].join("\n");
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") {
    out.push(line);
  }
  return out;
}

export function nextMigration(
  root: string,
  forge: Forge,
  options: { name?: string; description?: string; create?: boolean; excludeBranch?: string } = {},
): NextMigration {
  forge.fetchMain();
  const exclude = options.excludeBranch ?? forge.currentBranch();
  // The checkout's own new files count: they are this branch's, and the next one comes after.
  const taken = takenMigrations(root, forge, { excludeBranch: exclude });
  const highest = taken.reduce((max, t) => Math.max(max, t.number), 0);
  const number = highest + 1;
  const result: NextMigration = {
    number,
    padded: pad(number),
    newest: [...taken].sort((a, b) => b.number - a.number).slice(0, 5),
    warnings: [...forge.warnings],
  };
  if (options.create === true) {
    if (options.name === undefined) {
      throw new Error("creating the file needs a name");
    }
    const file = `${pad(number)}_${migrationName(options.name)}.sql`;
    const path = join(root, MIGRATIONS_DIR, file);
    if (existsSync(path)) {
      throw new Error(`${MIGRATIONS_DIR}/${file} exists already`);
    }
    writeText(path, migrationHeader(options.description ?? ""));
    result.created = `${MIGRATIONS_DIR}/${file}`;
  }
  return result;
}

export interface Clash {
  file: string;
  number: number;
  /** The other migrations with the same number. */
  with: Taken[];
}

export interface MigrationCheck {
  branch: string;
  /** Migrations the branch adds. */
  added: string[];
  clashes: Clash[];
  /** Added migrations numbered at or below main's newest: they would run out of order. */
  belowMain: string[];
  warnings: string[];
}

/** Clashes of a branch's new migrations with main, with open pull requests and with each other. */
export function checkMigrations(root: string, forge: Forge, branch: string): MigrationCheck {
  forge.fetchMain();
  const added = forge
    .branchFiles(branch, "A")
    .filter((path) => path.startsWith(`${MIGRATIONS_DIR}/`) && parse(baseName(path)) !== undefined)
    .map(baseName);
  const others = takenMigrations(root, forge, { excludeBranch: branch }).filter(
    (t) => t.where !== "checkout",
  );
  const mainNewest = others
    .filter((t) => t.where === "main")
    .reduce((max, t) => Math.max(max, t.number), 0);
  const clashes: Clash[] = [];
  const belowMain: string[] = [];
  for (const file of added) {
    const number = parse(file)?.number ?? 0;
    const same = others.filter((t) => t.number === number && t.file !== file);
    const twins = added.filter((f) => f !== file && parse(f)?.number === number);
    const all = [...same, ...twins.map((f) => ({ number, file: f, where: branch }))];
    if (all.length > 0) {
      clashes.push({ file, number, with: all });
    }
    if (number <= mainNewest && !others.some((t) => t.where === "main" && t.file === file)) {
      belowMain.push(file);
    }
  }
  return { branch, added, clashes, belowMain, warnings: [...forge.warnings] };
}
