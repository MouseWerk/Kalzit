#!/usr/bin/env node
// Renders the milestone progress bars of the README from docs/roadmap/progress.json:
// docs/roadmap/progress-dark.svg and progress-light.svg, the alt text of their <img> in
// README.md and the Status column of the README's roadmap table.
//
// To update the progress: edit docs/roadmap/progress.json, run
//
//   node tools/roadmap/render-progress.mjs
//
// and commit the JSON, both SVGs and README.md. CI runs it with --check, which writes nothing
// and fails when a committed file differs from what the script would write.
//
// Colors come from the design tokens (ui/src/styles/tokens.css, the light-dark() pairs of the
// first :root block), converted from oklch to hex so every SVG renderer understands them. The
// SVGs animate with CSS only (GitHub shows them through <img>, where scripts never run): each bar
// fills once on load with a staggered start, the bar of the milestone in progress gets a slow
// sweep, and prefers-reduced-motion shows the final state without any motion.
//
// Plain Node, no dependencies.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const paths = {
  data: join(root, "docs/roadmap/progress.json"),
  tokens: join(root, "ui/src/styles/tokens.css"),
  readme: join(root, "README.md"),
  dark: join(root, "docs/roadmap/progress-dark.svg"),
  light: join(root, "docs/roadmap/progress-light.svg"),
};

const STATUS_TEXT = { done: "Done", "in-progress": "In progress", planned: "Planned" };

// --- Data -------------------------------------------------------------------------------------

function loadMilestones() {
  const data = JSON.parse(readFileSync(paths.data, "utf8"));
  if (!Array.isArray(data.milestones) || data.milestones.length === 0) {
    throw new Error("progress.json: milestones must be a non-empty list");
  }
  return data.milestones.map((m) => {
    if (!/^M\d+$/.test(m.id ?? "")) throw new Error(`progress.json: bad milestone id ${m.id}`);
    if (!(m.status in STATUS_TEXT)) throw new Error(`progress.json: ${m.id} has bad status ${m.status}`);
    let done = null;
    let total = null;
    if (m.items !== undefined) {
      if (!Array.isArray(m.items) || m.items.length === 0) {
        throw new Error(`progress.json: ${m.id} items must be a non-empty list`);
      }
      const ids = new Set();
      for (const item of m.items) {
        if (ids.has(item.id)) throw new Error(`progress.json: ${m.id} lists item ${item.id} twice`);
        ids.add(item.id);
        if (typeof item.done !== "boolean") throw new Error(`progress.json: ${m.id} item ${item.id} needs done`);
      }
      total = m.items.length;
      done = m.items.filter((item) => item.done).length;
      if (m.status === "done" && done !== total) throw new Error(`progress.json: ${m.id} is done but has open items`);
    } else if (m.status === "in-progress") {
      throw new Error(`progress.json: ${m.id} is in progress and needs an item list`);
    }
    const fraction = m.status === "done" ? 1 : m.status === "planned" ? 0 : done / total;
    return { id: m.id, name: m.name, status: m.status, unit: m.unit ?? "items", done, total, fraction };
  });
}

function statusLabel(m) {
  if (m.status === "in-progress") return `${m.done} of ${m.total}`;
  return STATUS_TEXT[m.status];
}

function sentence(m) {
  if (m.status === "in-progress") return `${m.id} ${m.name}: in progress, ${m.done} of ${m.total} ${m.unit} done`;
  return `${m.id} ${m.name}: ${STATUS_TEXT[m.status].toLowerCase()}`;
}

function altText(milestones) {
  return `Milestone progress. ${milestones.map(sentence).join(". ")}.`;
}

// --- Colors -----------------------------------------------------------------------------------

function oklchToHex(l, c, h) {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
  return `#${linear
    .map((x) => {
      const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

function parseOklch(text) {
  const m = /oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(text);
  if (!m) throw new Error(`tokens.css: cannot read ${text}`);
  return oklchToHex(Number(m[1]) / 100, Number(m[2]), Number(m[3]));
}

function loadPalettes() {
  const css = readFileSync(paths.tokens, "utf8");
  const block = /:root\s*\{([\s\S]*?)\n\s*\}/.exec(css);
  if (!block) throw new Error("tokens.css: no :root block");
  const pick = (name) => {
    const m = new RegExp(`--${name}:\\s*light-dark\\((oklch\\([^)]*\\)),\\s*(oklch\\([^)]*\\))\\)`).exec(block[1]);
    if (!m) throw new Error(`tokens.css: no light-dark() value for --${name}`);
    return { light: parseOklch(m[1]), dark: parseOklch(m[2]) };
  };
  // Card and hairline like a Kalzit card; the track is the hairline tone, the fill the muted text
  // tone, as in the update progress bar of the UI. The sweep is the text tone at low opacity.
  const tokens = {
    card: pick("bg-raised"),
    border: pick("border"),
    track: pick("border"),
    fill: pick("text-muted"),
    text: pick("text"),
    muted: pick("text-muted"),
  };
  const theme = (mode) => Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, v[mode]]));
  return { dark: theme("dark"), light: theme("light") };
}

// --- SVG --------------------------------------------------------------------------------------

const WIDTH = 880;
const PAD = 24;
const HEAD = 72;
const ROW = 30;
const BAR_X = 210;
const BAR_W = 540;
const BAR_H = 6;
const FILL_S = 1.2;
const STAGGER_S = 0.09;
const SWEEP_W = 120;
const SWEEP_S = 4.8;

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n) => Number(n.toFixed(2)).toString();

function renderSvg(milestones, c) {
  const height = HEAD + (milestones.length - 1) * ROW + PAD + 4;
  const desc = altText(milestones);
  const keyframes = [];
  const rows = milestones.map((m, i) => {
    const y = HEAD + i * ROW;
    const barY = y - BAR_H / 2 - 4;
    const fillW = BAR_W * m.fraction;
    const delay = num(i * STAGGER_S);
    const current = m.status === "in-progress";
    const parts = [
      `<g class="row">`,
      `<text class="id" x="${PAD}" y="${y}">${m.id}</text>`,
      `<text class="name" x="${PAD + 40}" y="${y}">${escape(m.name)}</text>`,
      `<rect class="track" x="${BAR_X}" y="${num(barY)}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>`,
    ];
    if (fillW > 0) {
      parts.push(
        `<rect class="fill" x="${BAR_X}" y="${num(barY)}" width="${num(fillW)}" height="${BAR_H}" rx="${BAR_H / 2}" style="animation-delay:${delay}s"/>`,
      );
    }
    if (current && fillW > 0) {
      const name = `sweep-${m.id.toLowerCase()}`;
      keyframes.push(
        `@keyframes ${name}{0%{transform:translateX(0)}55%,100%{transform:translateX(${num(fillW + SWEEP_W)}px)}}`,
        `.${name}{animation:${name} ${SWEEP_S}s ease-in-out ${num(i * STAGGER_S + FILL_S)}s infinite}`,
      );
      parts.push(
        `<clipPath id="clip-${m.id.toLowerCase()}"><rect x="${BAR_X}" y="${num(barY)}" width="${num(fillW)}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>`,
        `<g clip-path="url(#clip-${m.id.toLowerCase()})"><rect class="sweep ${name}" x="${BAR_X - SWEEP_W}" y="${num(barY)}" width="${SWEEP_W}" height="${BAR_H}" fill="url(#sweep)"/></g>`,
      );
    }
    parts.push(
      `<text class="status${current ? " current" : ""}" x="${WIDTH - PAD}" y="${y}" text-anchor="end">${escape(statusLabel(m))}</text>`,
      `</g>`,
    );
    return parts.join("\n");
  });

  const style = [
    `text{font-family:"Instrument Sans","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;font-size:13px;fill:${c.muted};font-variant-numeric:tabular-nums}`,
    `.title{font-size:14px;font-weight:600;fill:${c.text}}`,
    `.id{font-family:"JetBrains Mono",ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;font-size:12px;font-weight:600;fill:${c.text}}`,
    `.status.current{fill:${c.text};font-weight:600}`,
    `.track{fill:${c.track}}`,
    `.fill{fill:${c.fill};transform-box:fill-box;transform-origin:left center;animation:grow ${FILL_S}s cubic-bezier(.22,.7,.2,1) backwards}`,
    `@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}`,
    ...keyframes,
    `@media (prefers-reduced-motion:reduce){.fill,.sweep{animation:none}}`,
  ].join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Kalzit milestone progress</title>
<desc id="desc">${escape(desc)}</desc>
<defs>
<linearGradient id="sweep" x1="0" x2="1" y1="0" y2="0">
<stop offset="0" stop-color="${c.text}" stop-opacity="0"/>
<stop offset="0.5" stop-color="${c.text}" stop-opacity="0.45"/>
<stop offset="1" stop-color="${c.text}" stop-opacity="0"/>
</linearGradient>
</defs>
<style>
${style}
</style>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="12" fill="${c.card}" stroke="${c.border}"/>
<text class="title" x="${PAD}" y="${PAD + 12}">Milestones</text>
${rows.join("\n")}
</svg>
`;
}

// --- README -----------------------------------------------------------------------------------

function updateReadme(readme, milestones) {
  let out = readme;
  const img = /(<img src="docs\/roadmap\/progress-dark\.svg" alt=")[^"]*(")/;
  if (!img.test(out)) throw new Error('README.md: no <img src="docs/roadmap/progress-dark.svg" alt="...">');
  out = out.replace(img, `$1${escape(altText(milestones))}$2`);
  for (const m of milestones) {
    const row = new RegExp(`^(\\| ${m.id} [^|\\n]*\\|[^|\\n]*\\| )([^|\\n]+)( \\|)$`, "m");
    if (!row.test(out)) throw new Error(`README.md: no roadmap table row for ${m.id}`);
    out = out.replace(row, `$1${STATUS_TEXT[m.status]}$3`);
  }
  return out;
}

// --- Main -------------------------------------------------------------------------------------

const check = process.argv.includes("--check");
const milestones = loadMilestones();
const palettes = loadPalettes();
const outputs = [
  [paths.dark, renderSvg(milestones, palettes.dark)],
  [paths.light, renderSvg(milestones, palettes.light)],
  [paths.readme, updateReadme(readFileSync(paths.readme, "utf8").replace(/\r\n/g, "\n"), milestones)],
];

let stale = 0;
for (const [file, content] of outputs) {
  let current = null;
  try {
    current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch {
    // A missing file counts as stale.
  }
  if (current === content) continue;
  const name = file.slice(root.length + 1).replace(/\\/g, "/");
  if (check) {
    console.error(`${name} does not match docs/roadmap/progress.json`);
    stale += 1;
  } else {
    writeFileSync(file, content);
    console.log(`wrote ${name}`);
  }
}
if (stale > 0) {
  console.error("Run 'node tools/roadmap/render-progress.mjs' and commit the result.");
  process.exit(1);
}
