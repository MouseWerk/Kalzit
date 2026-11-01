import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { outDir, stamp } from "../paths.ts";
import { allInfra, type Classification, classifyJob } from "./classify.ts";
import {
  type CheckRun,
  checkRuns,
  DEFAULT_REPO,
  job as getJob,
  ghApi,
  type Job,
  jobIdOf,
  jobLog,
  jobsOfRun,
  pullRequest,
} from "./gh.ts";

export interface Target {
  repo?: string;
  pr?: number;
  run?: number;
  sha?: string;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export interface CheckSummary {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  jobId?: number;
}

export interface CiStatus {
  repo: string;
  sha: string;
  pr?: { number: number; state: string; mergeableState: string; url: string };
  run?: number;
  overall: "pending" | "green" | "red" | "none";
  counts: {
    total: number;
    pending: number;
    success: number;
    failure: number;
    skipped: number;
    cancelled: number;
  };
  failing: CheckSummary[];
  pendingChecks: string[];
  checks: CheckSummary[];
}

function summarise(
  checks: CheckSummary[],
): Pick<CiStatus, "overall" | "counts" | "failing" | "pendingChecks"> {
  const counts = {
    total: checks.length,
    pending: 0,
    success: 0,
    failure: 0,
    skipped: 0,
    cancelled: 0,
  };
  const failing: CheckSummary[] = [];
  const pendingChecks: string[] = [];
  for (const c of checks) {
    if (c.status !== "completed") {
      counts.pending += 1;
      pendingChecks.push(c.name);
    } else if (c.conclusion === "success" || c.conclusion === "neutral") counts.success += 1;
    else if (c.conclusion === "skipped") counts.skipped += 1;
    else if (c.conclusion === "cancelled") {
      counts.cancelled += 1;
      failing.push(c);
    } else if (FAILED.has(c.conclusion ?? "")) {
      counts.failure += 1;
      failing.push(c);
    }
  }
  const overall =
    checks.length === 0
      ? "none"
      : counts.pending > 0
        ? "pending"
        : failing.length > 0
          ? "red"
          : "green";
  return { overall, counts, failing, pendingChecks };
}

function fromCheck(c: CheckRun): CheckSummary {
  const summary: CheckSummary = {
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
    url: c.html_url,
  };
  if (c.app?.slug === "github-actions" || /\/actions\/runs\//.test(c.details_url ?? ""))
    summary.jobId = jobIdOf(c);
  return summary;
}

function fromJob(j: Job): CheckSummary {
  return { name: j.name, status: j.status, conclusion: j.conclusion, url: j.html_url, jobId: j.id };
}

export async function ciStatus(target: Target): Promise<CiStatus> {
  const repo = target.repo ?? DEFAULT_REPO;
  if (target.run !== undefined) {
    const runInfo = await ghApi<{ head_sha: string }>(`repos/${repo}/actions/runs/${target.run}`);
    const checks = (await jobsOfRun(repo, target.run)).map(fromJob);
    return { repo, sha: runInfo.head_sha, run: target.run, checks, ...summarise(checks) };
  }
  let sha = target.sha;
  let pr: CiStatus["pr"];
  if (target.pr !== undefined) {
    const info = await pullRequest(repo, target.pr);
    sha = info.head.sha;
    pr = {
      number: info.number,
      state: info.merged ? "merged" : info.state,
      mergeableState: info.mergeable_state,
      url: info.html_url,
    };
  }
  if (sha === undefined) throw new Error("give a pr, a run or a sha");
  const checks = (await checkRuns(repo, sha)).map(fromCheck);
  const status: CiStatus = { repo, sha, checks, ...summarise(checks) };
  if (pr !== undefined) status.pr = pr;
  return status;
}

export interface JobFailure extends Classification {
  name: string;
  jobId: number;
  runId: number;
  url: string;
  logSource: string;
  logPath?: string;
}

export interface CiFailures {
  repo: string;
  sha: string;
  failures: JobFailure[];
  /** Every failure is the runner's; rerunning the failed jobs may be enough. */
  allInfra: boolean;
  out: string;
}

/** Fetches, saves and classifies the logs of these failed jobs. */
export async function classifyJobs(
  repo: string,
  jobIds: readonly number[],
  out: string,
): Promise<JobFailure[]> {
  const failures: JobFailure[] = [];
  for (const jobId of jobIds) {
    const j = await getJob(repo, jobId);
    const log = await jobLog(repo, jobId, j.run_id);
    const input: Parameters<typeof classifyJob>[0] = { name: j.name, conclusion: j.conclusion };
    if (j.steps !== undefined) input.steps = j.steps;
    if (log.text !== undefined) input.log = log.text;
    const failure: JobFailure = {
      name: j.name,
      jobId,
      runId: j.run_id,
      url: j.html_url,
      logSource: log.source,
      ...classifyJob(input),
    };
    if (log.text !== undefined) {
      failure.logPath = join(out, `${jobId}-${j.name.replace(/[^\w.-]+/g, "_")}.log`);
      writeFileSync(failure.logPath, log.text);
    }
    failures.push(failure);
  }
  return failures;
}

export async function ciFailures(target: Target): Promise<CiFailures> {
  const status = await ciStatus(target);
  const out = outDir("ci", stamp());
  const ids = status.failing.flatMap((c) => (c.jobId === undefined ? [] : [c.jobId]));
  const failures = await classifyJobs(status.repo, ids, out);
  const result: CiFailures = {
    repo: status.repo,
    sha: status.sha,
    failures,
    allInfra: allInfra(failures),
    out,
  };
  writeFileSync(join(out, "failures.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
