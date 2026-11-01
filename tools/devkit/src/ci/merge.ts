import { outDir, stamp } from "../paths.ts";
import { ciStatus, classifyJobs, type JobFailure } from "./ci.ts";
import { DEFAULT_REPO, gh, ghApi, graphql, jobsOfRun, pullRequest } from "./gh.ts";

export interface MergeOptions {
  pr: number;
  repo?: string;
  /** Overall limit in minutes (default 90). */
  timeoutMinutes?: number;
  /** Seconds between polls (default 30). */
  pollSeconds?: number;
  /** Delete the head branch after the merge (default true; same-repository branches only). */
  deleteBranch?: boolean;
  log?: (line: string) => void;
}

export interface MergeResult {
  pr: number;
  result: "merged" | "dirty" | "checks-failed" | "queue-failed" | "timeout" | "closed";
  mergeCommit?: string;
  failures?: JobFailure[];
  events: string[];
}

const rerunnable = (failures: readonly JobFailure[]) =>
  failures.length > 0 &&
  failures.every((f) => f.category === "infra" || f.category === "cancelled");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Merges a pull request through the merge queue: waits for every check on its head, reruns the
 * failed jobs once when all failures are the runner's, enqueues it, and waits until it is
 * merged. A merge group that fails for the runner's reasons is enqueued once more. Stops on
 * conflicts (DIRTY) and on failures of the code, and reports why.
 */
export async function mergePr(options: MergeOptions): Promise<MergeResult> {
  const repo = options.repo ?? DEFAULT_REPO;
  const poll = (options.pollSeconds ?? 30) * 1000;
  const deadline = Date.now() + (options.timeoutMinutes ?? 90) * 60_000;
  const events: string[] = [];
  const note = (line: string) => {
    events.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    options.log?.(line);
  };
  const done = (result: MergeResult["result"], extra: Partial<MergeResult> = {}): MergeResult => {
    note(`result: ${result}`);
    return { pr: options.pr, result, events, ...extra };
  };
  const out = outDir("ci", `merge-${options.pr}-${stamp()}`);

  let pr = await pullRequest(repo, options.pr);
  if (pr.merged)
    return done("merged", pr.merge_commit_sha === null ? {} : { mergeCommit: pr.merge_commit_sha });
  if (pr.state !== "open") return done("closed");
  if (pr.mergeable_state === "dirty") return done("dirty");
  const head = pr.head.sha;
  note(`PR #${pr.number} (${pr.head.ref}) head ${head.slice(0, 7)}`);

  // 1. Every check on the head finished (twice in a row, so late checks are not missed).
  let rerun = false;
  for (;;) {
    let stable = 0;
    let status = await ciStatus({ repo, pr: options.pr });
    while (stable < 2) {
      if (Date.now() > deadline) return done("timeout");
      if (status.sha !== head) {
        note("the head changed while waiting; stopping");
        return done("checks-failed");
      }
      stable = status.overall === "pending" || status.overall === "none" ? 0 : stable + 1;
      if (stable < 2) {
        await sleep(stable === 0 ? poll : 5000);
        status = await ciStatus({ repo, pr: options.pr });
      }
    }
    note(
      `checks: ${status.counts.success} ok, ${status.counts.failure} failed, ${status.counts.skipped} skipped`,
    );
    if (status.overall === "green") break;
    const ids = status.failing.flatMap((c) => (c.jobId === undefined ? [] : [c.jobId]));
    const failures = await classifyJobs(repo, ids, out);
    if (!rerun && rerunnable(failures)) {
      rerun = true;
      for (const runId of new Set(failures.map((f) => f.runId))) {
        note(
          `rerunning the failed jobs of run ${runId} (runner faults: ${failures.map((f) => f.reasons[0]).join("; ")})`,
        );
        await gh(["run", "rerun", String(runId), "--failed", "-R", repo]).catch((e: Error) =>
          note(e.message),
        );
      }
      await sleep(Math.max(poll, 20_000));
      continue;
    }
    return done("checks-failed", { failures });
  }

  const merged = async (): Promise<MergeResult> => {
    const result = done(
      "merged",
      pr.merge_commit_sha === null ? {} : { mergeCommit: pr.merge_commit_sha },
    );
    if (options.deleteBranch !== false && pr.head.repo?.full_name === repo) {
      await ghApi(`repos/${repo}/git/refs/heads/${pr.head.ref}`, "DELETE").catch(() => {});
      events.push(`deleted branch ${pr.head.ref}`);
    }
    return result;
  };

  // 2. The merge queue, with one more try when the merge group failed for the runner's reasons.
  let requeued = false;
  for (;;) {
    try {
      await graphql(
        "mutation($id:ID!,$h:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$h}){mergeQueueEntry{state}}}",
        { id: pr.node_id, h: head },
      );
      note("enqueued in the merge queue");
    } catch (error) {
      const message = (error as Error).message;
      if (!/already (in|queued)/i.test(message)) {
        note(`enqueue failed: ${message}`);
        return done("queue-failed");
      }
      note("already in the merge queue");
    }
    const enqueuedAt = Date.now();
    let left = false;
    while (!left) {
      if (Date.now() > deadline) return done("timeout");
      await sleep(poll);
      pr = await pullRequest(repo, options.pr);
      if (pr.merged) return merged();
      if (pr.mergeable_state === "dirty") return done("dirty");
      const entry = await graphql<{
        repository: { pullRequest: { mergeQueueEntry: { state: string } | null } };
      }>(
        "query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){mergeQueueEntry{state}}}}",
        { o: repo.split("/")[0] ?? "", n: repo.split("/")[1] ?? "", p: options.pr },
      );
      const state = entry.repository.pullRequest.mergeQueueEntry?.state;
      // Out of the queue without a merge; give GitHub a moment to record the merge first.
      left = state === undefined && Date.now() - enqueuedAt > 60_000;
    }
    pr = await pullRequest(repo, options.pr);
    if (pr.merged) return merged();
    const failures = await mergeGroupFailures(repo, options.pr, out);
    note(`removed from the merge queue; ${failures.length} failed job(s) in the merge group`);
    if (!requeued && rerunnable(failures)) {
      requeued = true;
      note(
        `runner fault in the merge group (${failures.map((f) => f.reasons[0]).join("; ")}); enqueuing once more`,
      );
      continue;
    }
    return done("queue-failed", { failures });
  }
}

/** The failed jobs of the newest merge group run of this pull request. */
async function mergeGroupFailures(repo: string, pr: number, out: string): Promise<JobFailure[]> {
  const runs = await ghApi<{
    workflow_runs: { id: number; head_branch: string; created_at: string }[];
  }>(`repos/${repo}/actions/runs?event=merge_group&per_page=50`);
  const mine = runs.workflow_runs
    .filter((r) => r.head_branch.includes(`/pr-${pr}-`))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (mine === undefined) return [];
  const failed = (await jobsOfRun(repo, mine.id)).filter((j) =>
    ["failure", "timed_out", "startup_failure", "cancelled"].includes(j.conclusion ?? ""),
  );
  return classifyJobs(
    repo,
    failed.map((j) => j.id),
    out,
  );
}
