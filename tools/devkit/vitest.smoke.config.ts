import { defineConfig } from "vitest/config";

/**
 * The local smoke test: builds (or reuses) the server binary, starts an instance and stops it.
 * Needs cargo and the UI's node_modules; not part of CI (see README.md).
 */
export default defineConfig({
  test: {
    include: ["test/**/*.smoke.test.ts"],
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
  },
});
