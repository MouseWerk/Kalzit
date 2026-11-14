import { defineConfig } from "vitest/config";

/** The unit tests: a fake fetch, no server or network. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 2,
  },
});
