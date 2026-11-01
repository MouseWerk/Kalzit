import { git, lines, run, slash } from "./repo.ts";

/**
 * What the tools need from git and GitHub, behind one interface so tests can simulate open pull
 * requests, tags and releases. The real one asks `git` and `gh`; when `gh` is missing or offline
 * the GitHub parts answer empty and say so in `warnings`.
 */

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  /** Paths the pull request changes, relative to the repository root. */
  files: string[];
}

export interface Forge {
  /** Open pull requests with their changed files. */
  openPullRequests(): PullRequest[];
  /** Merged pull requests (head branch and commit), newest first. */
  mergedPullRequests(): Pick<PullRequest, "number" | "headRefName" | "headRefOid">[];
  /** File names directly in `dir` on the main branch (`origin/main`). */
  mainFiles(dir: string): string[];
  /** Paths a branch changes against main: added (`A`) or all (`*`). */
  branchFiles(branch: string, filter: "A" | "*"): string[];
  /** Git tags, such as `v0.4.2`. */
  tags(): string[];
  /** Tag names of GitHub releases, drafts included. */
  releaseTags(): string[];
  /** The branch checked out in the repository, or `HEAD` when detached. */
  currentBranch(): string;
  warnings: string[];
}

export const MAIN = "origin/main";

export function realForge(root: string): Forge {
  const warnings: string[] = [];
  let open: PullRequest[] | undefined;
  const gh = (args: string[]): string | undefined => {
    const result = run("gh", args, root);
    if (!result.ok) {
      warnings.push(
        `gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim().split("\n")[0]}`,
      );
      return undefined;
    }
    return result.stdout;
  };
  return {
    warnings,
    openPullRequests() {
      if (open === undefined) {
        const out = gh([
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "200",
          "--json",
          "number,title,headRefName,headRefOid,files",
        ]);
        const parsed = out === undefined ? [] : (JSON.parse(out) as RawPr[]);
        open = parsed.map((pr) => ({
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRefName,
          headRefOid: pr.headRefOid ?? "",
          files: (pr.files ?? []).map((file) => slash(file.path)),
        }));
      }
      return open;
    },
    mergedPullRequests() {
      const out = gh([
        "pr",
        "list",
        "--state",
        "merged",
        "--limit",
        "300",
        "--json",
        "number,headRefName,headRefOid",
      ]);
      return out === undefined
        ? []
        : (JSON.parse(out) as RawPr[]).map((pr) => ({
            number: pr.number,
            headRefName: pr.headRefName,
            headRefOid: pr.headRefOid ?? "",
          }));
    },
    mainFiles(dir) {
      const result = git(root, "ls-tree", "--name-only", `${MAIN}:${dir}`);
      if (!result.ok) {
        warnings.push(`${MAIN} is not available; run git fetch origin`);
        return [];
      }
      return lines(result.stdout);
    },
    branchFiles(branch, filter) {
      const args = ["diff", "--name-only", "--no-renames"];
      if (filter === "A") {
        args.push("--diff-filter=A");
      }
      args.push(`${MAIN}...${branch}`);
      const result = git(root, ...args);
      if (!result.ok) {
        warnings.push(`git diff ${MAIN}...${branch} failed: ${result.stderr.trim()}`);
        return [];
      }
      return lines(result.stdout).map(slash);
    },
    tags() {
      return lines(git(root, "tag", "--list").stdout);
    },
    releaseTags() {
      const out = gh(["release", "list", "--limit", "200", "--json", "tagName"]);
      return out === undefined
        ? []
        : (JSON.parse(out) as { tagName: string }[]).map((r) => r.tagName);
    },
    currentBranch() {
      return git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim() || "HEAD";
    },
  };
}

interface RawPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid?: string;
  files?: { path: string }[];
}

/** A forge from fixed data, for tests and dry runs. */
export function fakeForge(data: Partial<Omit<Forge, "warnings">> = {}): Forge {
  return {
    warnings: [],
    openPullRequests: () => [],
    mergedPullRequests: () => [],
    mainFiles: () => [],
    branchFiles: () => [],
    tags: () => [],
    releaseTags: () => [],
    currentBranch: () => "HEAD",
    ...data,
  };
}
