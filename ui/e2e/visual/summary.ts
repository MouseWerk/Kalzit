import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * The reporter of the visual run: which screens differ from their baselines, as a short list on
 * the console, in e2e/.output/visual-diffs/summary.md (and the job summary on GitHub), with the
 * expected, actual and diff pictures of each next to it, named by width, screen and theme.
 */

export const DIFF_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".output",
  "visual-diffs",
);

interface Difference {
  project: string;
  screen: string;
  files: string[];
  message: string;
}

const PICTURE = /-(expected|actual|diff)\.png$/;

export default class VisualSummary implements Reporter {
  private readonly differences: Difference[] = [];
  private readonly failures: Difference[] = [];
  private screens = 0;

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? "";
    if (result.status === "passed") {
      this.screens += 1;
      return;
    }
    if (result.status === "skipped") {
      return;
    }
    const pictures = result.attachments.filter(
      (attachment) => attachment.path !== undefined && PICTURE.test(attachment.name),
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal color codes
    const plain = (result.error?.message ?? result.status).replace(/\u001b\[[0-9;]*m/g, "");
    const message = plain.split("\n")[0] ?? "";
    const entry = { project, screen: test.title, files: [] as string[], message };
    for (const picture of pictures) {
      const source = picture.path ?? "";
      const target = join(DIFF_DIR, project, basename(picture.name));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      entry.files.push(join(project, basename(picture.name)).replaceAll("\\", "/"));
    }
    // A screen differs when the comparison made a diff picture; anything else is a failure to
    // reach the screen's state.
    const differs = pictures.some((picture) => picture.name.endsWith("-diff.png"));
    (differs ? this.differences : this.failures).push(entry);
  }

  onEnd(result: FullResult): void {
    const lines = [
      "# Visual comparison",
      "",
      `Result: ${result.status}. Tests passed: ${this.screens}. Screens that differ: ${this.differences.length}. Other failures: ${this.failures.length}.`,
      "",
    ];
    if (this.differences.length > 0) {
      lines.push("## Screens that differ from their baselines", "");
      for (const entry of this.differences) {
        const kinds = new Set(entry.files.map((file) => PICTURE.exec(file)?.[1]));
        lines.push(`- ${entry.project}: ${entry.screen} (${[...kinds].join(", ")})`);
      }
      lines.push(
        "",
        "The pictures are in ui/e2e/.output/visual-diffs/<width>/. If the change is intended, run `npm run visual:update` on Linux and commit the new baselines; a reviewer looks at each image diff.",
        "",
      );
    }
    if (this.failures.length > 0) {
      lines.push("## Screens that did not reach their state", "");
      for (const entry of this.failures) {
        lines.push(`- ${entry.project}: ${entry.screen}: ${entry.message}`);
      }
      lines.push("");
    }
    const text = lines.join("\n");
    if (this.differences.length > 0 || this.failures.length > 0) {
      mkdirSync(DIFF_DIR, { recursive: true });
      writeFileSync(join(DIFF_DIR, "summary.md"), text);
      process.stdout.write(`\n${text}\n`);
    }
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary !== undefined && summary !== "") {
      appendFileSync(summary, `${text}\n`);
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
