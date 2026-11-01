import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Some tests read every catalog and UI source file of the repository; slow runners need time.
    testTimeout: 30_000,
  },
});
