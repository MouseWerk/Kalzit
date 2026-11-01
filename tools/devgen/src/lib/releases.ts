import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Forge, PullRequest } from "./forge.ts";
import { readText, writeText } from "./repo.ts";

/**
 * Release notes (`docs/releases/v<version>.md`, CLAUDE.md "Release notes"). A line belongs in the
 * newest notes file whose version has neither a git tag nor a GitHub release (nor an open
 * `release/v<version>` pull request); once that version is out, the next minor version gets a
 * new file.
 */

export const RELEASES_DIR = "docs/releases";

export const SECTIONS = {
  improved: "## Improved",
  fixed: "## Fixed",
  windows: "## Checklist for Windows (manual)",
} as const;
export type Section = keyof typeof SECTIONS;
const ORDER: readonly Section[] = ["improved", "fixed", "windows"];

type Version = [number, number, number];

export function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\.md)?$/.exec(text.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionText(version: Version): string {
  return version.join(".");
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export interface NotesTarget {
  version: string;
  /** Relative to the repository root. */
  file: string;
  exists: boolean;
  /** Why this file: the newest unreleased one, a new one after a release, or asked for. */
  reason: string;
  /** Released versions among the notes files, newest first. */
  released: string[];
  /** Open pull requests (other than this branch) that create the same file. */
  othersCreating: Pick<PullRequest, "number" | "title" | "headRefName">[];
  warnings: string[];
}

export function notesTarget(
  root: string,
  forge: Forge,
  options: { version?: string } = {},
): NotesTarget {
  const dir = join(root, RELEASES_DIR);
  const versions = (existsSync(dir) ? readdirSync(dir) : [])
    .map(parseVersion)
    .filter((v): v is Version => v !== undefined)
    .sort((a, b) => compare(b, a));
  // A release pull request (`release/v0.5.0`), open or merged before the tag exists, closes its
  // version's notes as well.
  const releasing = [...forge.openPullRequests(), ...forge.mergedPullRequests()]
    .map((pr) => /^release\/(v\d+\.\d+\.\d+)$/.exec(pr.headRefName)?.[1])
    .filter((tag): tag is string => tag !== undefined);
  const releasedTags = new Set([...forge.tags(), ...forge.releaseTags(), ...releasing]);
  const isReleased = (v: Version) => releasedTags.has(`v${versionText(v)}`);
  let version: Version;
  let reason: string;
  if (options.version !== undefined) {
    const asked = parseVersion(options.version);
    if (asked === undefined) {
      throw new Error(`${options.version} is not a version like 0.6.0`);
    }
    if (isReleased(asked)) {
      throw new Error(`v${versionText(asked)} is released already; its notes are closed`);
    }
    version = asked;
    reason = "asked for";
  } else {
    const newest = versions[0];
    if (newest === undefined) {
      version = [0, 1, 0];
      reason = "no notes yet";
    } else if (!isReleased(newest)) {
      version = newest;
      reason = "newest notes file without a tag or release";
    } else {
      version = [newest[0], newest[1] + 1, 0];
      reason = `v${versionText(newest)} is released; the next minor version starts`;
    }
  }
  const file = `${RELEASES_DIR}/v${versionText(version)}.md`;
  const exists = existsSync(join(root, file));
  const branch = forge.currentBranch();
  const onMain = forge.mainFiles(RELEASES_DIR).includes(`v${versionText(version)}.md`);
  const othersCreating = onMain
    ? []
    : forge
        .openPullRequests()
        .filter((pr) => pr.headRefName !== branch && pr.files.includes(file))
        .map(({ number, title, headRefName }) => ({ number, title, headRefName }));
  return {
    version: versionText(version),
    file,
    exists,
    reason,
    released: versions.filter(isReleased).map(versionText),
    othersCreating,
    warnings: [...forge.warnings],
  };
}

export function emptyNotes(version: string): string {
  return `# Kalzit ${version}\n\n${ORDER.map((s) => SECTIONS[s]).join("\n\n")}\n`;
}

/** One bullet, wrapped at 100 columns with a two-space hanging indent, as the notes are. */
export function bullet(text: string, width = 100): string[] {
  const words = text
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .split(" ");
  const out: string[] = [];
  let line = "-";
  for (const word of words) {
    if (line.length + 1 + word.length > width && line.trim() !== "-") {
      out.push(line);
      line = `  ${word}`;
    } else {
      line = `${line} ${word}`;
    }
  }
  out.push(line);
  return out;
}

/** The notes with `text` appended to `section`; adds the section in order if it is missing. */
export function insertNote(notes: string, section: Section, text: string): string {
  const lines = notes.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  let start = lines.indexOf(SECTIONS[section]);
  if (start === -1) {
    // Before the first heading of a later section, else at the end.
    const later = ORDER.slice(ORDER.indexOf(section) + 1).map((s) => SECTIONS[s]);
    const before = lines.findIndex((line) => later.includes(line as never));
    const at = before === -1 ? lines.length : before;
    const block = before === -1 ? ["", SECTIONS[section]] : [SECTIONS[section], ""];
    lines.splice(at, 0, ...block);
    start = lines.indexOf(SECTIONS[section]);
  }
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end === -1) {
    end = lines.length;
  }
  let last = end;
  while (last - 1 > start && (lines[last - 1] ?? "").trim() === "") {
    last--;
  }
  const insert = [...(last === start + 1 ? [""] : []), ...bullet(text)];
  const tail = end === lines.length ? [] : [""];
  lines.splice(last, end - last, ...insert, ...tail);
  return `${lines.join("\n")}\n`;
}

export interface AddedNote extends NotesTarget {
  created: boolean;
  section: Section;
}

export function addReleaseNote(
  root: string,
  forge: Forge,
  options: { section: Section; text: string; version?: string },
): AddedNote {
  if (options.text.trim() === "") {
    throw new Error("the note needs a text");
  }
  const target = notesTarget(
    root,
    forge,
    options.version === undefined ? {} : { version: options.version },
  );
  const path = join(root, target.file);
  const before = target.exists ? readText(path) : emptyNotes(target.version);
  writeText(path, insertNote(before, options.section, options.text));
  const warnings = [...target.warnings];
  for (const pr of target.othersCreating) {
    warnings.push(
      `#${pr.number} (${pr.headRefName}) also creates ${target.file}; whoever merges second rebases and merges the two files`,
    );
  }
  return { ...target, warnings, created: !target.exists, section: options.section };
}
