import { mkdirSync, rmSync } from "node:fs";
import baseSetup from "../global-setup";
import { VISUAL_DIR } from "./stage";
import { DIFF_DIR } from "./summary";

/**
 * The e2e setup (the release binary on a free port with a fresh data directory, the fixture data
 * around the fixed moment), with the folders of the last visual run emptied first.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const dir of [VISUAL_DIR, DIFF_DIR]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  mkdirSync(VISUAL_DIR, { recursive: true });
  return baseSetup();
}
