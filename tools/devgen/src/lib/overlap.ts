import type { Forge, PullRequest } from "./forge.ts";

/**
 * Files that open pull requests share, found before merge time. Each shared file gets a hint at
 * what usually happens there; migration numbers taken twice count as a clash even when the file
 * names differ.
 */

export interface SharedFile {
  file: string;
  /** The pull requests (or the branch) that change it. */
  by: string[];
  hint: string;
  /** Files where both sides usually edit the same lines. */
  likelyConflict: boolean;
}

export interface OverlapReport {
  subject: string;
  shared: SharedFile[];
  migrationClashes: { number: string; files: string[] }[];
  warnings: string[];
}

const HINTS: [RegExp, string, boolean][] = [
  [
    /^server\/migrations\//,
    "the same migration file: one of them must take the next free number",
    true,
  ],
  [
    /^docs\/releases\/v[\d.]+\.md$/,
    "both add release notes; the second to merge rebases and keeps both lines",
    true,
  ],
  [
    /^ui\/src\/i18n\/(de|en)\/\w+\.json$/,
    "catalog keys added next to each other conflict as text; keep both keys",
    true,
  ],
  [
    /^ui\/src\/api\/generated\/shapes\.ts$/,
    "generated: after rebasing run KALZIT_UPDATE_GENERATED=1 cargo test instead of merging by hand",
    true,
  ],
  [
    /(^|\/)(Cargo\.lock|package-lock\.json)$/,
    "lock file: regenerate it after rebasing instead of merging by hand",
    true,
  ],
  [
    /^server\/src\/routes\/mod\.rs$/,
    "both register routes or guard entries; keep every entry",
    true,
  ],
  [
    /^server\/src\/settings\.rs$/,
    "both add settings or rules; keep every registry entry and match arm",
    true,
  ],
  [
    /^server\/src\/datasources\/detail\.rs$/,
    "both extend the reasons check lists; keep every entry",
    true,
  ],
  [
    /^ui\/src\/features\/settings\/sections\.ts$/,
    "both place settings in sections; keep both keys",
    true,
  ],
  [
    /^docs\/api\//,
    "both document routes or reasons; check the Reasons tables after rebasing",
    false,
  ],
  [/^\.github\//, "CI or workflow changes on both sides; review them together", false],
  [/^\.mcp\.json$/, "both register MCP servers; keep every server entry", true],
  [/^README\.md$|^docs\/screenshots\//, "screenshots and README: the later PR retakes them", false],
];

export function hintFor(file: string): { hint: string; likelyConflict: boolean } {
  for (const [pattern, hint, likely] of HINTS) {
    if (pattern.test(file)) {
      return { hint, likelyConflict: likely };
    }
  }
  return { hint: "same file: read both diffs before merging", likelyConflict: false };
}

function label(pr: Pick<PullRequest, "number" | "headRefName">): string {
  return pr.number > 0 ? `#${pr.number} ${pr.headRefName}` : pr.headRefName;
}

export function prOverlap(
  forge: Forge,
  options: { branch?: string; pr?: number } = {},
): OverlapReport {
  const open = forge.openPullRequests();
  let subject: PullRequest | undefined;
  if (options.pr !== undefined) {
    subject = open.find((pr) => pr.number === options.pr);
    if (subject === undefined) {
      throw new Error(`#${options.pr} is not an open pull request`);
    }
  } else if (options.branch !== undefined) {
    const branch = options.branch;
    subject = open.find((pr) => pr.headRefName === branch) ?? {
      number: 0,
      title: branch,
      headRefName: branch,
      headRefOid: "",
      files: forge.branchFiles(branch, "*"),
    };
  }
  const byFile = new Map<string, Set<string>>();
  const add = (file: string, who: string) => {
    byFile.set(file, (byFile.get(file) ?? new Set()).add(who));
  };
  const others =
    subject === undefined ? open : open.filter((pr) => pr.headRefName !== subject.headRefName);
  if (subject !== undefined) {
    const mine = new Set(subject.files);
    for (const pr of others) {
      for (const file of pr.files) {
        if (mine.has(file)) {
          add(file, label(subject));
          add(file, label(pr));
        }
      }
    }
  } else {
    for (const pr of open) {
      for (const file of pr.files) {
        add(file, label(pr));
      }
    }
  }
  const shared = [...byFile]
    .filter(([, who]) => who.size > 1)
    .map(([file, who]) => ({ file, by: [...who].sort(), ...hintFor(file) }))
    .sort(
      (a, b) => Number(b.likelyConflict) - Number(a.likelyConflict) || a.file.localeCompare(b.file),
    );

  // Migration numbers taken by more than one side, whatever the file names.
  const numbers = new Map<string, Set<string>>();
  const sides = subject === undefined ? open : [subject, ...others];
  for (const pr of sides) {
    for (const file of pr.files) {
      const match = /^server\/migrations\/(\d{4})_[\w]+\.sql$/.exec(file);
      if (match !== null) {
        const key = match[1] ?? "";
        numbers.set(
          key,
          (numbers.get(key) ?? new Set()).add(
            `${file.slice("server/migrations/".length)} (${label(pr)})`,
          ),
        );
      }
    }
  }
  const migrationClashes = [...numbers]
    .filter(([, files]) => files.size > 1)
    .filter(
      ([, files]) =>
        subject === undefined || [...files].some((f) => f.endsWith(`(${label(subject)})`)),
    )
    .map(([number, files]) => ({ number, files: [...files].sort() }));
  return {
    subject: subject === undefined ? "all open pull requests" : label(subject),
    shared,
    migrationClashes,
    warnings: [...forge.warnings],
  };
}
