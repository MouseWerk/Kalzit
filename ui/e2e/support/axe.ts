import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/** Serious and critical axe findings, with the first elements of each, readable in a failure. */
export async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(" ")}: ${n.failureSummary?.replace(/\s+/g, " ")}`);
      return `${v.id} (${v.impact}): ${v.help}\n${nodes.join("\n")}`;
    });
}
