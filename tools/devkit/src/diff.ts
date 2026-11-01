import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { outDir, stamp } from "./paths.ts";

export interface DiffScore {
  changedPixels: number;
  totalPixels: number;
  /** Changed pixels as a share of all pixels, 0 to 1. */
  score: number;
  sizeChanged: boolean;
  diff: PNG;
}

/** Copies an image onto a transparent canvas of the given size (top left aligned). */
function pad(image: PNG, width: number, height: number): PNG {
  if (image.width === width && image.height === height) return image;
  const canvas = new PNG({ width, height });
  PNG.bitblt(image, canvas, 0, 0, image.width, image.height, 0, 0);
  return canvas;
}

/**
 * Compares two images pixel by pixel. `threshold` (0 to 1, default 0.1) is pixelmatch's color
 * distance below which pixels count as equal; anti-aliased pixels are never counted. Images of
 * different sizes are compared on the larger canvas, where the area only one covers counts as
 * changed.
 */
export function scoreImages(before: PNG, after: PNG, threshold = 0.1): DiffScore {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const a = pad(before, width, height);
  const b = pad(after, width, height);
  const diff = new PNG({ width, height });
  const changedPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold,
    includeAA: false,
    alpha: 0.3,
  });
  const totalPixels = width * height;
  return {
    changedPixels,
    totalPixels,
    score: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    sizeChanged: before.width !== after.width || before.height !== after.height,
    diff,
  };
}

export interface DiffOptions {
  before: string;
  after: string;
  out?: string;
  /** pixelmatch's per-pixel color threshold (default 0.1). */
  threshold?: number;
  /** Share of changed pixels at or below which a screen counts as unchanged (default 0.0005). */
  minScore?: number;
}

export interface DiffEntry {
  file: string;
  status: "changed" | "unchanged" | "added" | "removed";
  score?: number;
  changedPixels?: number;
  sizeChanged?: boolean;
  diffImage?: string;
}

export interface DiffReport {
  out: string;
  before: string;
  after: string;
  threshold: number;
  minScore: number;
  changed: number;
  unchanged: number;
  added: number;
  removed: number;
  entries: DiffEntry[];
  html: string;
  markdown: string;
}

function pngs(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.toLowerCase().endsWith(".png") && !name.endsWith(".diff.png")) {
        found.push(relative(dir, path).replaceAll("\\", "/"));
      }
    }
  };
  walk(dir);
  return found;
}

export function visualDiff(options: DiffOptions): DiffReport {
  const before = resolve(options.before);
  const after = resolve(options.after);
  for (const dir of [before, after]) {
    if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
  }
  const out = resolve(options.out ?? outDir("diffs", stamp()));
  mkdirSync(out, { recursive: true });
  const threshold = options.threshold ?? 0.1;
  const minScore = options.minScore ?? 0.0005;
  const a = new Set(pngs(before));
  const b = new Set(pngs(after));
  const entries: DiffEntry[] = [];
  for (const file of [...new Set([...a, ...b])].sort()) {
    if (!a.has(file)) {
      entries.push({ file, status: "added" });
      continue;
    }
    if (!b.has(file)) {
      entries.push({ file, status: "removed" });
      continue;
    }
    const result = scoreImages(
      PNG.sync.read(readFileSync(join(before, file))),
      PNG.sync.read(readFileSync(join(after, file))),
      threshold,
    );
    const changed = result.sizeChanged || result.score > minScore;
    const entry: DiffEntry = {
      file,
      status: changed ? "changed" : "unchanged",
      score: Number(result.score.toFixed(6)),
      changedPixels: result.changedPixels,
      sizeChanged: result.sizeChanged,
    };
    if (changed) {
      const diffPath = join(out, file.replace(/\.png$/i, ".diff.png"));
      mkdirSync(dirname(diffPath), { recursive: true });
      writeFileSync(diffPath, PNG.sync.write(result.diff));
      entry.diffImage = diffPath;
    }
    entries.push(entry);
  }
  // Most changed first, then added and removed.
  const order = { changed: 0, added: 1, removed: 2, unchanged: 3 } as const;
  entries.sort((x, y) => order[x.status] - order[y.status] || (y.score ?? 0) - (x.score ?? 0));
  const count = (s: DiffEntry["status"]) => entries.filter((e) => e.status === s).length;
  const report: DiffReport = {
    out,
    before,
    after,
    threshold,
    minScore,
    changed: count("changed"),
    unchanged: count("unchanged"),
    added: count("added"),
    removed: count("removed"),
    entries,
    html: join(out, "report.html"),
    markdown: join(out, "report.md"),
  };
  writeFileSync(report.markdown, markdownReport(report));
  writeFileSync(report.html, htmlReport(report));
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function percent(score: number | undefined): string {
  return score === undefined ? "" : `${(score * 100).toFixed(3)} %`;
}

export function markdownReport(report: DiffReport): string {
  const lines = [
    "# Visual diff",
    "",
    `Before: \`${report.before}\`  `,
    `After: \`${report.after}\`  `,
    `Threshold ${report.threshold}, screens with at most ${percent(report.minScore)} changed pixels count as unchanged.`,
    "",
    `${report.changed} changed, ${report.added} added, ${report.removed} removed, ${report.unchanged} unchanged.`,
    "",
  ];
  const listed = report.entries.filter((e) => e.status !== "unchanged");
  if (listed.length > 0) {
    lines.push("| Screen | Status | Changed pixels | Diff |", "|---|---|---|---|");
    for (const e of listed) {
      const diff = e.diffImage === undefined ? "" : `\`${basename(e.diffImage)}\``;
      const size = e.sizeChanged === true ? " (size changed)" : "";
      lines.push(`| ${e.file} | ${e.status}${size} | ${percent(e.score)} | ${diff} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

function fileUrl(path: string): string {
  return `file:///${path.replaceAll("\\", "/").replace(/^\//, "")}`;
}

function htmlReport(report: DiffReport): string {
  const rows = report.entries
    .filter((e) => e.status !== "unchanged")
    .map((e) => {
      const img = (dir: string) =>
        `<img loading="lazy" src="${escapeHtml(fileUrl(join(dir, e.file)))}">`;
      const before = e.status === "added" ? "" : img(report.before);
      const after = e.status === "removed" ? "" : img(report.after);
      const diff =
        e.diffImage === undefined
          ? ""
          : `<img loading="lazy" src="${escapeHtml(fileUrl(e.diffImage))}">`;
      return `<section><h2>${escapeHtml(e.file)} <small>${e.status} ${percent(e.score)}</small></h2><div class="row"><figure>${before}<figcaption>before</figcaption></figure><figure>${after}<figcaption>after</figcaption></figure><figure>${diff}<figcaption>diff</figcaption></figure></div></section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Visual diff</title>
<style>
body{font:14px system-ui,sans-serif;margin:16px;background:#111;color:#ddd}
.row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
img{width:100%;border:1px solid #333;background:#fff}
figure{margin:0}figcaption{color:#999}small{color:#999;font-weight:normal}
</style></head><body>
<h1>Visual diff</h1>
<p>${report.changed} changed, ${report.added} added, ${report.removed} removed, ${report.unchanged} unchanged (threshold ${report.threshold}).</p>
${rows}
</body></html>
`;
}
