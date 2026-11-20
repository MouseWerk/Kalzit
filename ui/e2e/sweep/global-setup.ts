import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import baseSetup from "../global-setup";
import { SWEEP_DIR, writeReport } from "./report";

/**
 * The e2e setup (the release binary on a free port with a fresh data directory), and afterwards
 * the sweep's report from what each run wrote down.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  rmSync(SWEEP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(join(SWEEP_DIR, "results"), { recursive: true });
  const stop = await baseSetup();
  // After the server is up: the report times the sweep, not the build.
  writeFileSync(join(SWEEP_DIR, "started.json"), JSON.stringify({ started: Date.now() }));
  return async () => {
    try {
      process.stdout.write(`${writeReport(Date.now())}\n`);
    } finally {
      await stop();
    }
  };
}
