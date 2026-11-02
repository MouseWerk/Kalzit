import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/**
 * Findings that fail whatever axe rates them: two landmarks with the same role and name (such as a
 * region inside a region of the same name) read twice to screen reader users.
 */
const ALWAYS_FAIL = new Set(["landmark-unique"]);

/**
 * Serious and critical axe findings, and the ones in ALWAYS_FAIL, with the first elements of each,
 * readable in a failure.
 */
export async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical" || ALWAYS_FAIL.has(v.id))
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(" ")}: ${n.failureSummary?.replace(/\s+/g, " ")}`);
      return `${v.id} (${v.impact}): ${v.help}\n${nodes.join("\n")}`;
    });
}
