import { run } from "../proc.ts";

/** The repository the helpers act on unless one is given. */
export const DEFAULT_REPO = "MouseWerk/Kalzit";

export async function gh(args: readonly string[], input?: string): Promise<string> {
  const options: { timeoutMs: number; input?: string } = { timeoutMs: 120_000 };
  if (input !== undefined) options.input = input;
  const result = await run("gh", args, options);
  if (result.code !== 0) {
    throw new Error(
      `gh ${args.slice(0, 3).join(" ")} failed: ${result.stderr.trim().slice(0, 500)}`,
    );
  }
  return result.stdout;
}

export async function ghApi<T>(path: string, method = "GET"): Promise<T> {
  const text = await gh(["api", "-X", method, path]);
  return (text.trim() === "" ? undefined : JSON.parse(text)) as T;
}

export async function graphql<T>(
  query: string,
  variables: Record<string, string | number>,
): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  const parsed = JSON.parse(await gh(args)) as { data?: T; errors?: { message: string }[] };
  if (parsed.errors !== undefined && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((e) => e.message).join("; "));
  }
  return parsed.data as T;
}

export interface PullRequest {
  number: number;
  node_id: string;
  state: string;
  merged: boolean;
  mergeable_state: string;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  html_url: string;
}

export function pullRequest(repo: string, pr: number): Promise<PullRequest> {
  return ghApi<PullRequest>(`repos/${repo}/pulls/${pr}`);
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  details_url: string | null;
  app?: { slug: string } | null;
}

export async function checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
  const all: CheckRun[] = [];
  for (let page = 1; page < 20; page++) {
    const batch = await ghApi<{ check_runs: CheckRun[] }>(
      `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    all.push(...batch.check_runs);
    if (batch.check_runs.length < 100) break;
  }
  // A rerun adds a new check run under the same name; the newest one counts.
  const newest = new Map<string, CheckRun>();
  for (const runItem of all) {
    const seen = newest.get(runItem.name);
    if (seen === undefined || runItem.id > seen.id) newest.set(runItem.name, runItem);
  }
  return [...newest.values()];
}

export interface Job {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  steps?: { name: string; number: number; status: string; conclusion: string | null }[];
}

export function job(repo: string, jobId: number): Promise<Job> {
  return ghApi<Job>(`repos/${repo}/actions/jobs/${jobId}`);
}

export async function jobsOfRun(repo: string, runId: number): Promise<Job[]> {
  const data = await ghApi<{ jobs: Job[] }>(
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return data.jobs;
}

/**
 * A job's log: through the REST API first, then `gh run view --job --log` (which reads the same
 * logs another way and sometimes succeeds when the first answers "log not found"), then the
 * failed-steps log of the run. Undefined when none of them has it.
 */
export async function jobLog(
  repo: string,
  jobId: number,
  runId: number,
): Promise<{ text?: string; source: string }> {
  const attempts: [string, string[]][] = [
    ["api", ["api", `repos/${repo}/actions/jobs/${jobId}/logs`]],
    ["run view --log", ["run", "view", String(runId), "-R", repo, "--job", String(jobId), "--log"]],
    ["run view --log-failed", ["run", "view", String(runId), "-R", repo, "--log-failed"]],
  ];
  for (const [source, args] of attempts) {
    try {
      const text = await gh(args);
      if (text.trim() !== "") return { text, source };
    } catch {
      // Next way.
    }
  }
  return { source: "none" };
}

/** The Actions job id of a check run (for Actions the check run id is the job id). */
export function jobIdOf(check: CheckRun): number {
  const match = /\/job\/(\d+)/.exec(check.details_url ?? check.html_url);
  return match?.[1] !== undefined ? Number(match[1]) : check.id;
}
