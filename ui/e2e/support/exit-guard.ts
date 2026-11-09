import { spawn } from "node:child_process";
import type { FullResult, Reporter } from "@playwright/test/reporter";

/**
 * How long the test runner may take to exit after its last report. Playwright itself forces the
 * exit 30 s after the run returns; this waits longer, so it only acts when that did not happen.
 */
const EXIT_GRACE_MS = 60_000;
/** After that, a separate process ends the runner should its own timer not get to run. */
const KILL_AFTER_MS = 90_000;
const POLL_MS = 500;

function warn(message: string): void {
  // An annotation on the run in GitHub Actions, a plain line elsewhere.
  const prefix = process.env.GITHUB_ACTIONS === "true" ? "::warning::" : "";
  process.stderr.write(`${prefix}e2e: ${message}\n`);
}

/**
 * Waits for the runner's PID to go away; when it is still there at the deadline, reports that
 * and kills it. Runs as a process of its own, so a runner whose main thread is blocked (or that
 * hangs inside process.exit) is still ended. It polls only while the runner lives, so the PID
 * cannot be taken over by another process in between.
 */
const WATCHDOG = `
const [pid, ms, poll, prefix] = [Number(process.argv[1]), Number(process.argv[2]), Number(process.argv[3]), process.argv[4] ?? ""];
const deadline = Date.now() + ms;
const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const timer = setInterval(() => {
  if (!alive()) { clearInterval(timer); return; }
  if (Date.now() < deadline) return;
  clearInterval(timer);
  process.stderr.write(prefix + "e2e: the test runner (PID " + pid + ") was still running " + (ms / 1000) + " s after its last report; killing it\\n");
  try { process.kill(pid, "SIGKILL"); } catch {}
  process.exitCode = 1;
}, poll);
`;

/**
 * Makes sure the test run ends once every test and the global teardown are done. A run on CI
 * once stayed alive for the rest of the step's time limit after printing its summary, with no
 * output; this turns such a hang into a short wait with a message that names what was still
 * open. Listed last in the config, so its onEnd comes after the other reporters have written.
 */
export default class ExitGuard implements Reporter {
  onEnd(result: FullResult): void {
    const code = result.status === "passed" ? 0 : 1;
    const timer = setTimeout(() => {
      // Includes this timer itself ("Timeout").
      const open = process.getActiveResourcesInfo();
      warn(
        `the test runner did not exit ${EXIT_GRACE_MS / 1000} s after its last report ` +
          `(the run ${result.status}); still open: ${open.join(", ")}; ` +
          "exiting now",
      );
      process.exit(code);
    }, EXIT_GRACE_MS);
    // The timer itself must not keep the runner alive.
    timer.unref();

    const prefix = process.env.GITHUB_ACTIONS === "true" ? "::warning::" : "";
    const watchdog = spawn(
      process.execPath,
      ["-e", WATCHDOG, String(process.pid), String(KILL_AFTER_MS), String(POLL_MS), prefix],
      { detached: true, stdio: ["ignore", "ignore", "inherit"], windowsHide: true },
    );
    watchdog.unref();
  }

  printsToStdio(): boolean {
    return false;
  }
}
