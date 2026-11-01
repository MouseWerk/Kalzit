/**
 * Reads a failed CI job: which tests failed, the assertion lines, and whether the failure is the
 * code's or the runner's (a service container that could not bind its port, a job that failed
 * without a failed step, network and download errors). Pure functions, so the rules are tested
 * on log excerpts (test/classify.test.ts).
 */

export interface JobStep {
  name: string;
  number?: number;
  conclusion: string | null;
}

export interface JobInput {
  name: string;
  conclusion: string | null;
  steps?: JobStep[];
  /** The job's log, or undefined when it could not be fetched. */
  log?: string;
}

export type Category = "code" | "infra" | "cancelled" | "unknown";

export interface Classification {
  category: Category;
  reasons: string[];
  failedSteps: string[];
  failingTests: string[];
  assertions: string[];
}

/** Removes the timestamp GitHub puts before every log line and terminal color codes. */
export function cleanLog(log: string): string[] {
  return (
    log
      .replace(/\r\n/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal color codes
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .split("\n")
      // `gh run view --log` puts the job and step name before the timestamp, tab-separated.
      .map((line) => line.replace(/^[^\t\n]*\t[^\t\n]*\t(?=\uFEFF?\d{4}-\d\d-\d\dT)/, ""))
      .map((line) => line.replace(/^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/, ""))
      // The runner's own markup (step headers, action names) is not output; its errors are.
      .filter((line) => !line.startsWith("##[") || line.startsWith("##[error]"))
      .map((line) => line.replace(/^##\[error\]/, ""))
  );
}

interface Rule {
  pattern: RegExp;
  reason: string;
}

/** Faults of the runner or its services, whatever the code does. */
const INFRA_STRONG: Rule[] = [
  {
    pattern:
      /port is already allocated|Bind for [\d.:[\]]+ failed|Error response from daemon.*address already in use/i,
    reason: "a service container could not bind its port",
  },
  {
    pattern: /Failed to initialize container|Error: failed to start containers/i,
    reason: "a service container did not start",
  },
  {
    pattern:
      /The runner has received a shutdown signal|lost communication with the server|The hosted runner encountered an error|Runner .* did not respond/i,
    reason: "the runner went away",
  },
  { pattern: /No space left on device/i, reason: "the runner ran out of disk space" },
  {
    pattern:
      /Failed to download action|Unable to resolve action|An action could not be found at the URI/i,
    reason: "an action could not be downloaded",
  },
];

/** Network and download errors: infra unless the log also shows failing tests. */
const INFRA_WEAK: Rule[] = [
  {
    pattern:
      /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED)\b.*\b(registry|npmjs|github|crates\.io|download|fetch)/i,
    reason: "a network error while downloading",
  },
  {
    pattern:
      /Could not resolve host|Temporary failure in name resolution|TLS handshake timeout|connection reset by peer|socket hang up/i,
    reason: "a network error",
  },
  {
    pattern:
      /failed to download|Download failed|error: failed to (fetch|download|get)|failed to fetch `|npm (ERR!|error) (network|code E(CONNRESET|TIMEDOUT|AI_AGAIN))/i,
    reason: "a download failed",
  },
  {
    pattern:
      /(503 Service Unavailable|502 Bad Gateway|504 Gateway Time-?out|429 Too Many Requests|returned error: 5\d\d)/i,
    reason: "a server answered with an error while downloading",
  },
  { pattern: /address already in use/i, reason: "a port was already in use" },
];

const TEST_PATTERNS: { pattern: RegExp; group: number }[] = [
  // cargo test
  { pattern: /^---- (\S+) stdout ----$/, group: 1 },
  { pattern: /^test (\S+) \.\.\. FAILED$/, group: 1 },
  // vitest
  { pattern: /^\s*FAIL\s+(\S+\.test\.tsx?(?: > .+)?)$/, group: 1 },
  { pattern: /^\s*[×✗]\s+(\S+\.test\.tsx?.*)$/, group: 1 },
  // Playwright: the numbered list of the summary (a ✘ in the progress can be an expected failure
  // or a retry that later passed).
  { pattern: /^\s*\d+\) (\[\w[\w-]*\] › .+?)\s*$/, group: 1 },
];

/** Errors that are the code's even without a test name: compiler, type checker, linters. */
const CODE_ERRORS: Rule[] = [
  {
    pattern: /^error(\[E\d+\])?: (?!failed to (fetch|download|get))/,
    reason: "the Rust compiler or clippy reported an error",
  },
  { pattern: /error TS\d+:/, reason: "the type check failed" },
  { pattern: /^test result: FAILED/, reason: "cargo tests failed" },
  { pattern: /Found \d+ errors?\./, reason: "the linter or formatter reported errors" },
  { pattern: /^Diff in .*\.rs/, reason: "cargo fmt found unformatted code" },
  { pattern: /^FAIL: /, reason: "a script test failed" },
  { pattern: /Tests? Files?\s+\d+ failed/, reason: "vitest tests failed" },
  { pattern: /^\s*\d+ failed$/, reason: "Playwright tests failed" },
];

const ASSERTION =
  /panicked at|assertion|assert_eq|assert_ne|^\s*left: |^\s*right: |Expected:|Received:|expect\(|AssertionError|toBe|toEqual|toHave|^\s*Error: /;

function unique(items: string[], limit: number): string[] {
  return [...new Set(items)].slice(0, limit);
}

export function classifyJob(job: JobInput): Classification {
  const failedSteps = (job.steps ?? [])
    .filter((s) => s.conclusion === "failure" || s.conclusion === "timed_out")
    .map((s) => s.name);
  const result: Classification = {
    category: "unknown",
    reasons: [],
    failedSteps,
    failingTests: [],
    assertions: [],
  };
  if (job.conclusion === "cancelled") {
    result.category = "cancelled";
    result.reasons.push("the job was cancelled");
    return result;
  }
  const steps = job.steps ?? [];
  const lines = job.log === undefined ? [] : cleanLog(job.log);
  const tests: string[] = [];
  const assertions: string[] = [];
  const codeReasons: string[] = [];
  const strong: string[] = [];
  const weak: string[] = [];
  for (const line of lines) {
    for (const { pattern, group } of TEST_PATTERNS) {
      const name = pattern.exec(line)?.[group];
      if (name !== undefined) tests.push(name.trim());
    }
    if (ASSERTION.test(line)) assertions.push(line.trim().slice(0, 300));
    for (const rule of CODE_ERRORS) if (rule.pattern.test(line)) codeReasons.push(rule.reason);
    for (const rule of INFRA_STRONG) if (rule.pattern.test(line)) strong.push(rule.reason);
    for (const rule of INFRA_WEAK) if (rule.pattern.test(line)) weak.push(rule.reason);
  }
  result.failingTests = unique(tests, 30);
  result.assertions = unique(assertions, 20);

  const failedWithoutStep =
    (job.conclusion === "failure" || job.conclusion === "startup_failure") &&
    steps.length > 0 &&
    failedSteps.length === 0;
  const hasCode = result.failingTests.length > 0 || codeReasons.length > 0;
  // A job that ran into timeout-minutes ends with its running step cancelled and this annotation;
  // a hang in the code looks the same as a slow runner, so it is never taken as the runner's.
  const timedOut =
    job.conclusion === "timed_out" ||
    steps.some((s) => s.conclusion === "cancelled") ||
    lines.some((l) => /exceeded the maximum execution time/i.test(l));
  // Steps that run the product itself: a reset connection there can be the server crashing.
  const productStep = failedSteps.find((s) => /smoke|health|docker|package|msi|install/i.test(s));

  if (strong.length > 0) {
    result.category = "infra";
    result.reasons.push(...unique(strong, 5));
  } else if (timedOut) {
    result.category = hasCode ? "code" : "unknown";
    result.reasons.push("the job hit its time limit (a hang or a slow runner); not rerun");
    if (hasCode) result.reasons.push(...unique(codeReasons, 5));
  } else if (failedWithoutStep) {
    result.category = "infra";
    result.reasons.push("the job failed without a failed step");
  } else if (hasCode) {
    result.category = "code";
    result.reasons.push(...unique(codeReasons, 5));
    if (result.failingTests.length > 0)
      result.reasons.push(`${result.failingTests.length} failing test(s)`);
    if (weak.length > 0) result.reasons.push(`also seen: ${unique(weak, 3).join(", ")}`);
  } else if (weak.length > 0 && productStep !== undefined) {
    result.reasons.push(
      `${unique(weak, 3).join(", ")} in step "${productStep}", which runs the product: could be a crash`,
    );
  } else if (weak.length > 0) {
    result.category = "infra";
    result.reasons.push(...unique(weak, 5));
  } else if (job.log === undefined) {
    result.reasons.push("the log could not be fetched");
  } else {
    result.reasons.push(
      failedSteps.length > 0
        ? `step "${failedSteps[0]}" failed without a recognised test or error line`
        : "no recognised failure in the log",
    );
  }
  return result;
}

/** Whether every failed job of a set failed for the runner's reasons (a rerun may help). */
export function allInfra(classes: readonly Classification[]): boolean {
  return classes.length > 0 && classes.every((c) => c.category === "infra");
}
