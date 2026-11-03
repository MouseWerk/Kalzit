// Checks the size of the built bundle (dist/) against ui/bundle-budget.json, gzip-compressed as a
// browser receives it, so a change that makes the first page load heavier shows in CI instead of
// in the field. `npm run budget` after `npm run build`; CI runs it in the ui job.
//
//   start      everything index.html loads before the first render: its module script, the
//              chunks it preloads and its stylesheets
//   language   each language catalog (src/i18n/en.ts, de.ts); none may be part of the start,
//              since the page fetches only the language it shows (src/i18n/i18n.ts)
//   lazy       chunks that must not be part of the start either (the time picker's popover)
//   chunk      any other chunk outside the start, unless `chunks` names its own limit (elk,
//              loaded on demand)
//   total      all JavaScript and CSS together
//
// A limit is in bytes. When a change needs more, raise the limit in the same pull request and
// say why; the budget is a decision, not a measurement.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** A chunk's name without its content hash: "assets/en-CV4Xs72S.js" is "en". */
export function chunkName(file) {
  const base = file.split("/").pop() ?? file;
  return base.replace(/-[\w-]{8}\.(js|css)$/, "").replace(/\.(js|css)$/, "");
}

/** The files index.html loads before the first render, as paths below dist ("assets/..."). */
export function startFiles(html) {
  const files = new Set();
  const pattern = /<(script|link)\b[^>]*>/g;
  for (const [tag, kind] of html.matchAll(pattern)) {
    const type = /\btype="module"/.test(tag);
    const rel = /\brel="(modulepreload|stylesheet)"/.exec(tag)?.[1];
    const ref = /\b(?:src|href)="\/?(assets\/[^"]+)"/.exec(tag)?.[1];
    if (ref === undefined) continue;
    if ((kind === "script" && type) || (kind === "link" && rel !== undefined)) {
      files.add(ref);
    }
  }
  return [...files];
}

/**
 * The problems of a bundle against a budget; empty when it fits. `sizes` maps each JavaScript and
 * CSS file below dist to its gzip size, `start` lists what index.html loads.
 */
export function check(budget, sizes, start) {
  const problems = [];
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
  const startSet = new Set(start);
  // A start that names nothing, or a file the bundle does not have, would measure as small as
  // it likes: index.html changed its form, or the build left something out.
  if (start.length === 0) {
    problems.push(
      "index.html loads no script or stylesheet from assets/; the start cannot be measured",
    );
  }
  for (const file of start) {
    if (!sizes.has(file)) {
      problems.push(`index.html loads ${file}, which is not in the bundle`);
    }
  }
  const startSize = start.reduce((sum, file) => sum + (sizes.get(file) ?? 0), 0);
  if (startSize > budget.start) {
    problems.push(
      `the first page load is ${kb(startSize)} gzip, the budget is ${kb(budget.start)}`,
    );
  }
  const languages = new Set(budget.languages);
  const lazy = new Set(budget.lazy);
  const seen = new Set();
  let total = 0;
  for (const [file, size] of sizes) {
    total += size;
    if (!file.endsWith(".js")) continue;
    const name = chunkName(file);
    if (languages.has(name)) {
      seen.add(name);
      if (startSet.has(file)) {
        problems.push(`the language catalog ${name} is loaded on start; it must load on demand`);
      }
      if (size > budget.language) {
        problems.push(
          `the language catalog ${name} is ${kb(size)} gzip, the budget is ${kb(budget.language)}`,
        );
      }
      continue;
    }
    if (lazy.has(name)) {
      seen.add(name);
      if (startSet.has(file)) {
        problems.push(`${name} is loaded on start; it must load when it is first used`);
      }
    }
    // What the start loads counts against the start's limit.
    const limit = budget.chunks[name] ?? budget.chunk;
    if (!startSet.has(file) && size > limit) {
      problems.push(`the chunk ${name} is ${kb(size)} gzip, the budget is ${kb(limit)}`);
    }
  }
  for (const name of [...languages, ...lazy]) {
    if (!seen.has(name)) {
      problems.push(`no chunk ${name} in the bundle; the budget names it (bundle-budget.json)`);
    }
  }
  if (total > budget.total) {
    problems.push(`the bundle is ${kb(total)} gzip in all, the budget is ${kb(budget.total)}`);
  }
  return { problems, startSize, total };
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|css)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function main() {
  const uiRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
  const dist = join(uiRoot, "dist");
  const budget = JSON.parse(readFileSync(join(uiRoot, "bundle-budget.json"), "utf8"));
  const sizes = new Map();
  for (const path of listFiles(join(dist, "assets"))) {
    const file = relative(dist, path).replaceAll("\\", "/");
    sizes.set(file, gzipSync(readFileSync(path)).length);
  }
  const start = startFiles(readFileSync(join(dist, "index.html"), "utf8"));
  const { problems, startSize, total } = check(budget, sizes, start);
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
  const lines = [
    `first page load: ${kb(startSize)} gzip in ${start.length} files (budget ${kb(budget.start)})`,
    `whole bundle: ${kb(total)} gzip in ${sizes.size} files (budget ${kb(budget.total)})`,
    ...[...sizes]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(
        ([file, size]) =>
          `  ${kb(size).padStart(9)}  ${file}${start.includes(file) ? "  (start)" : ""}`,
      ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  if (problems.length > 0) {
    process.stderr.write(`${problems.map((problem) => `bundle budget: ${problem}`).join("\n")}\n`);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
