import { defineConfig } from "vitest/config";

/** The unit tests: no server, browser, Docker or network. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.smoke.test.ts"],
    maxWorkers: 2,
  },
});
