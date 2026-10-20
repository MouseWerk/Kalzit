import { vi } from "vitest";

/**
 * Console guard for tests. Any warning or error logged during a test fails it, unless the test
 * declared that exact output as expected (React and the router log errors that reach an error
 * boundary, which is the point of an error-path test). An expected pattern that never shows up
 * fails the test too, so expectations cannot go stale.
 */
let logged: string[] = [];
let expected: RegExp[] = [];

export function startConsoleGuard(): void {
  logged = [];
  expected = [];
  for (const level of ["warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(`console.${level}: ${args.map(String).join(" ")}`);
    });
  }
}

/** Declares console output this test is expected to produce. */
export function expectConsoleOutput(...patterns: RegExp[]): void {
  expected.push(...patterns);
}

export function finishConsoleGuard(): void {
  const unexpected = logged.filter((line) => !expected.some((pattern) => pattern.test(line)));
  const missing = expected.filter((pattern) => !logged.some((line) => pattern.test(line)));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected console output:\n${unexpected.join("\n")}`);
  }
  if (missing.length > 0) {
    throw new Error(`Expected console output did not appear: ${missing.join(", ")}`);
  }
}
