import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Check, Finding, Severity } from "../support/audit";
import { appRoutes, matchesRoute } from "../support/routes";
import { UNVISITED_ROUTES } from "./pages";

/** Where the sweep writes: results per run, the screenshots and the report. */
export const SWEEP_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".output",
  "ui-sweep",
);

export interface Variant {
  theme: "light" | "dark";
  language: "de" | "en";
  width: number;
  height: number;
}

export const variantName = (v: Variant) => `${v.theme}-${v.language}-${v.width}`;

export interface PageResult {
  page: string;
  /** The address the page was opened at and the one it ended on, without the server. */
  path: string;
  url: string;
  /** The screenshot, relative to the report. */
  shot?: string;
  ms: number;
  findings: Finding[];
}

export interface VariantResult {
  variant: Variant;
  started: number;
  ended: number;
  pages: PageResult[];
}

const RANK: Record<Severity, number> = { broken: 0, off: 1, polish: 2 };
const TITLE: Record<Severity, string> = {
  broken: "Broken",
  off: "Clearly off",
  polish: "Polish",
};

/** One finding of a page, joined across the variants it shows in. */
interface Joined {
  page: string;
  check: Check;
  severity: Severity;
  element: string;
  kind: string;
  label: string;
  allowed?: string;
  /** Per variant: the measured values and where the element is in that variant's screenshot. */
  seen: { variant: string; detail: string; shot?: string; rect?: Finding["rect"] }[];
}

function readResults(): VariantResult[] {
  const dir = join(SWEEP_DIR, "results");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as VariantResult)
    .sort((a, b) => variantName(a.variant).localeCompare(variantName(b.variant)));
}

function join_(results: VariantResult[]): Joined[] {
  const joined = new Map<string, Joined>();
  for (const result of results) {
    for (const page of result.pages) {
      for (const finding of page.findings) {
        const key = [page.page, finding.check, finding.element, finding.kind].join("|");
        let entry = joined.get(key);
        if (entry === undefined) {
          entry = {
            page: page.page,
            check: finding.check,
            severity: finding.severity,
            element: finding.element,
            kind: finding.kind,
            label: finding.label,
            seen: [],
          };
          if (finding.allowed !== undefined) {
            entry.allowed = finding.allowed;
          }
          joined.set(key, entry);
        }
        if (RANK[finding.severity] < RANK[entry.severity]) {
          entry.severity = finding.severity;
        }
        const variant = variantName(result.variant);
        // One line per variant: a list of twenty cut cells is one finding.
        if (!entry.seen.some((seen) => seen.variant === variant)) {
          entry.seen.push({
            variant,
            detail: finding.detail,
            ...(page.shot === undefined ? {} : { shot: page.shot }),
            ...(finding.rect === undefined ? {} : { rect: finding.rect }),
          });
        }
      }
    }
  }
  return shared([...joined.values()]).sort(
    (a, b) =>
      a.page.localeCompare(b.page) ||
      RANK[a.severity] - RANK[b.severity] ||
      a.check.localeCompare(b.check) ||
      a.element.localeCompare(b.element),
  );
}

/** Where findings of the shell and of shared components go: one entry instead of one per page. */
export const SHARED = "(shared) shell and components on many pages";
const SHARED_FROM = 6;

/**
 * The same element with the same fault on many pages is one finding of the shell or of a shared
 * component: it moves to SHARED, with the number of pages in its label.
 */
function shared(findings: Joined[]): Joined[] {
  const groups = new Map<string, Joined[]>();
  for (const finding of findings) {
    const key = [finding.check, finding.element, finding.kind].join("|");
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    if (first === undefined || group.length < SHARED_FROM) {
      return group;
    }
    const seen: Joined["seen"] = [];
    for (const finding of group) {
      for (const entry of finding.seen) {
        if (!seen.some((other) => other.variant === entry.variant)) {
          seen.push(entry);
        }
      }
    }
    const severity = group.map((finding) => finding.severity).sort((a, b) => RANK[a] - RANK[b])[0];
    return [
      {
        ...first,
        page: SHARED,
        severity: severity ?? first.severity,
        label: `${first.label} (on ${group.length} pages, such as ${group
          .slice(0, 3)
          .map((finding) => finding.page)
          .join(", ")})`,
        seen,
      },
    ];
  });
}

/** "all" or the variants in short, such as "dark, 390 px" when both languages show it. */
function where(seen: Joined["seen"], all: string[]): string {
  const names = seen.map((s) => s.variant);
  if (names.length === all.length) {
    return "all";
  }
  const parts = names.map((name) => name.split("-") as [string, string, string]);
  const axis = (index: 0 | 1 | 2) => [...new Set(parts.map((p) => p[index]))];
  const total = (index: 0 | 1 | 2) => new Set(all.map((name) => name.split("-")[index])).size;
  const themes = axis(0);
  const languages = axis(1);
  const widths = axis(2);
  // Only a full product of its axes reads as "dark, 390 px"; anything else is listed.
  if (themes.length * languages.length * widths.length !== names.length) {
    return names.join(", ");
  }
  const said = [
    themes.length === total(0) ? "" : themes.join("/"),
    languages.length === total(1) ? "" : languages.join("/"),
    widths.length === total(2) ? "" : `${widths.join("/")} px`,
  ].filter((part) => part !== "");
  return said.join(", ");
}

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function coverage(results: VariantResult[]) {
  const visited = new Set(results.flatMap((r) => r.pages.flatMap((p) => [p.path, p.url])));
  const routes = appRoutes().filter((route) => !route.redirectOnly);
  const patterns = [...new Set(routes.map((route) => route.pattern))];
  const reached = patterns.filter((pattern) =>
    [...visited].some((url) => matchesRoute(pattern, url)),
  );
  const missed = patterns.filter((pattern) => !reached.includes(pattern));
  return { patterns, reached, missed };
}

function markdown(results: VariantResult[], findings: Joined[], wallMs: number): string {
  const all = results.map((r) => variantName(r.variant));
  const open = findings.filter((f) => f.allowed === undefined);
  const pages = [...new Set(results.flatMap((r) => r.pages.map((p) => p.page)))];
  const cover = coverage(results);
  const lines: string[] = [
    "# UI sweep",
    "",
    `${pages.length} pages x ${all.length} variants (${all.join(", ")}), ${results.reduce((n, r) => n + r.pages.length, 0)} page views in ${(wallMs / 60_000).toFixed(1)} min.`,
    `Routes: ${cover.reached.length} of ${cover.patterns.length} reached${cover.missed.length === 0 ? "" : `; not reached: ${cover.missed.map((m) => `\`${m}\`${UNVISITED_ROUTES[m] === undefined ? "" : ` (${UNVISITED_ROUTES[m]})`}`).join(", ")}`}.`,
    "",
    "| Check | Broken | Clearly off | Polish | Allowed |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const check of [...new Set(findings.map((f) => f.check))].sort()) {
    const of = (severity: Severity) =>
      open.filter((f) => f.check === check && f.severity === severity).length;
    const allowed = findings.filter((f) => f.check === check && f.allowed !== undefined).length;
    lines.push(`| ${check} | ${of("broken")} | ${of("off")} | ${of("polish")} | ${allowed} |`);
  }
  lines.push("");
  for (const page of [...new Set(open.map((f) => f.page))]) {
    lines.push(`## ${page}`, "");
    for (const severity of ["broken", "off", "polish"] as const) {
      const list = open.filter((f) => f.page === page && f.severity === severity);
      if (list.length === 0) {
        continue;
      }
      lines.push(`**${TITLE[severity]}**`, "");
      for (const f of list) {
        const label = f.label === "" ? "" : ` "${cell(f.label)}"`;
        lines.push(
          `- ${f.check}: \`${cell(f.element)}\`${label}: ${cell(f.kind)} (${cell(f.seen[0]?.detail ?? "")}) [${where(f.seen, all)}]`,
        );
      }
      lines.push("");
    }
  }
  const allowed = findings.filter((f) => f.allowed !== undefined);
  if (allowed.length > 0) {
    lines.push("## Allowed", "");
    const reasons = new Map<string, Joined[]>();
    for (const f of allowed) {
      reasons.set(f.allowed ?? "", [...(reasons.get(f.allowed ?? "") ?? []), f]);
    }
    for (const [reason, list] of reasons) {
      lines.push(
        `- ${list[0]?.check}: ${list.length} findings on ${new Set(list.map((f) => f.page)).size} pages: ${reason}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

const STYLE = `
:root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
body { margin: 0 auto; max-width: 1100px; padding: 24px; }
h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 40px; border-top: 1px solid #8884; padding-top: 16px; }
h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
table { border-collapse: collapse; } td, th { padding: 2px 12px 2px 0; text-align: right; } td:first-child, th:first-child { text-align: left; }
details { border: 1px solid #8884; border-radius: 7px; margin: 6px 0; padding: 6px 10px; }
summary { cursor: pointer; } code { font-size: 12px; }
.where { opacity: .7; } .detail { margin: 6px 0; font-size: 13px; }
.crop { position: relative; overflow: hidden; border: 1px solid #8886; border-radius: 4px; background: #8881; margin: 8px 0; }
.crop img { position: absolute; max-width: none; } .crop i { position: absolute; border: 2px solid #e5484d; box-sizing: border-box; }
nav a { margin-right: 12px; white-space: nowrap; display: inline-block; }
`;

/** A cut of the screenshot around the element, with its box marked. */
function crop(shot: string, rect: NonNullable<Finding["rect"]>, width: number): string {
  const view = { width: Math.min(width, 720), height: 220 };
  const left = Math.max(0, Math.min(rect.x + rect.width / 2 - view.width / 2, width - view.width));
  const top = Math.max(0, rect.y + rect.height / 2 - view.height / 2);
  const box = `left:${rect.x - left}px;top:${rect.y - top}px;width:${Math.max(rect.width, 4)}px;height:${Math.max(rect.height, 4)}px`;
  return `<div class="crop" style="width:${view.width}px;height:${view.height}px"><img loading="lazy" src="${escapeHtml(shot)}" style="left:${-left}px;top:${-top}px;width:${width}px" alt=""><i style="${box}"></i></div>`;
}

function html(results: VariantResult[], findings: Joined[], wallMs: number): string {
  const all = results.map((r) => variantName(r.variant));
  const open = findings.filter((f) => f.allowed === undefined);
  const pages = [...new Set(results.flatMap((r) => r.pages.map((p) => p.page)))];
  const id = (page: string) => `p-${page.replace(/[^a-z0-9]+/gi, "-")}`;
  const out: string[] = [
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Kalzit UI sweep</title><style>${STYLE}</style>`,
    "<h1>Kalzit UI sweep</h1>",
    `<p>${pages.length} pages x ${all.length} variants, ${(wallMs / 60_000).toFixed(1)} min. ${open.length} findings (${open.filter((f) => f.severity === "broken").length} broken, ${open.filter((f) => f.severity === "off").length} clearly off, ${open.filter((f) => f.severity === "polish").length} polish), ${findings.length - open.length} allowed.</p>`,
    "<nav>",
    ...[SHARED, ...pages].map((page) => {
      const count = open.filter((f) => f.page === page).length;
      return `<a href="#${id(page)}">${escapeHtml(page)} (${count})</a>`;
    }),
    "</nav>",
  ];
  for (const page of [SHARED, ...pages]) {
    out.push(`<h2 id="${id(page)}">${escapeHtml(page)}</h2>`);
    const shots = results
      .map((r) => ({
        variant: variantName(r.variant),
        shot: r.pages.find((p) => p.page === page)?.shot,
      }))
      .filter((s) => s.shot !== undefined);
    out.push(
      `<p class="where">Screenshots: ${shots.map((s) => `<a href="${escapeHtml(s.shot ?? "")}">${s.variant}</a>`).join(" ")}</p>`,
    );
    for (const severity of ["broken", "off", "polish"] as const) {
      const list = open.filter((f) => f.page === page && f.severity === severity);
      if (list.length === 0) {
        continue;
      }
      out.push(`<h3>${TITLE[severity]}</h3>`);
      for (const f of list) {
        const example = f.seen.find((s) => s.rect !== undefined && s.shot !== undefined);
        const width = Number(example?.variant.split("-")[2] ?? 0);
        out.push(
          `<details><summary><b>${f.check}</b> ${escapeHtml(f.kind)} <code>${escapeHtml(f.element)}</code> ${escapeHtml(f.label)} <span class="where">[${where(f.seen, all)}]</span></summary>`,
          ...f.seen.map(
            (s) =>
              `<div class="detail"><span class="where">${s.variant}</span> ${escapeHtml(s.detail)}</div>`,
          ),
          example?.rect !== undefined && example.shot !== undefined
            ? `<div class="where">${example.variant}</div>${crop(example.shot, example.rect, width)}`
            : "",
          "</details>",
        );
      }
    }
  }
  const allowed = findings.filter((f) => f.allowed !== undefined);
  if (allowed.length > 0) {
    out.push('<h2 id="allowed">Allowed</h2>');
    for (const f of allowed) {
      out.push(
        `<div class="detail"><b>${f.check}</b> ${escapeHtml(f.page)} <code>${escapeHtml(f.element)}</code> ${escapeHtml(f.kind)}: ${escapeHtml(f.allowed ?? "")}</div>`,
      );
    }
  }
  out.push("</html>");
  return out.join("\n");
}

/** Joins what the runs wrote into report.json, report.md and report.html; answers one line. */
export function writeReport(now: number): string {
  const results = readResults();
  if (results.length === 0) {
    return "ui sweep: no results";
  }
  const startedFile = join(SWEEP_DIR, "started.json");
  const started = existsSync(startedFile)
    ? (JSON.parse(readFileSync(startedFile, "utf8")) as { started: number }).started
    : Math.min(...results.map((r) => r.started));
  const wallMs = now - started;
  const findings = join_(results);
  const cover = coverage(results);
  writeFileSync(
    join(SWEEP_DIR, "report.json"),
    JSON.stringify(
      {
        wallMs,
        variants: results.map((r) => ({
          ...r.variant,
          ms: r.ended - r.started,
          pages: r.pages.length,
        })),
        routes: cover,
        findings,
      },
      null,
      1,
    ),
  );
  writeFileSync(join(SWEEP_DIR, "report.md"), markdown(results, findings, wallMs));
  writeFileSync(join(SWEEP_DIR, "report.html"), html(results, findings, wallMs));
  const open = findings.filter((f) => f.allowed === undefined);
  const count = (severity: Severity) => open.filter((f) => f.severity === severity).length;
  return `ui sweep: ${count("broken")} broken, ${count("off")} clearly off, ${count("polish")} polish, ${findings.length - open.length} allowed; ${join(SWEEP_DIR, "report.html")}`;
}
