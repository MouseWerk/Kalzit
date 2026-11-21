// Writes the icon set of the graph style rules:
//   src/panels/graph/style/icons/lucide.json   name -> { d: one SVG path, tags: search words }
// from an unpacked `lucide-static` package (https://lucide.dev, ISC; the icons derived from
// Feather MIT) and the names in src/panels/graph/style/icons/names.txt. The set is a subset on
// purpose (about 300 icons, docs/PLAN.md section 15) until the product has icons of its own
// (M10). Its license text is src/panels/graph/style/icons/LICENSE, which the notices of the
// bundle carry (scripts/licenses.mjs).
//
//   node scripts/graph-icons.mjs <path to the unpacked lucide-static package>
//
// Every shape of an icon (circle, rect, line, ...) becomes path data, so an icon is one stroked
// path: the same string draws it in the page (an SVG path) and into the renderer's texture
// (Path2D), without markup the content security policy would have to allow.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(here, "..", "src", "panels", "graph", "style", "icons");

const number = (value) => Number(value ?? 0);

/** A circle or an ellipse as two arcs. */
function ellipse(cx, cy, rx, ry) {
  return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
}

function rect(a) {
  const x = number(a.x);
  const y = number(a.y);
  const w = number(a.width);
  const h = number(a.height);
  const rx = Math.min(number(a.rx ?? a.ry), w / 2);
  const ry = Math.min(number(a.ry ?? a.rx), h / 2);
  if (rx === 0 || ry === 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  const arc = (dx, dy) => `a${rx} ${ry} 0 0 1 ${dx} ${dy}`;
  return [
    `M${x + rx} ${y}`,
    `h${w - 2 * rx}`,
    arc(rx, ry),
    `v${h - 2 * ry}`,
    arc(-rx, ry),
    `h${-(w - 2 * rx)}`,
    arc(-rx, -ry),
    `v${-(h - 2 * ry)}`,
    arc(rx, -ry),
    "Z",
  ].join("");
}

function points(text, close) {
  const values = String(text)
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const parts = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    parts.push(`${i === 0 ? "M" : "L"}${values[i]} ${values[i + 1]}`);
  }
  return parts.join("") + (close ? "Z" : "");
}

/** One element of an icon as path data. */
export function toPath([tag, a]) {
  switch (tag) {
    case "path":
      return a.d;
    case "circle":
      return ellipse(number(a.cx), number(a.cy), number(a.r), number(a.r));
    case "ellipse":
      return ellipse(number(a.cx), number(a.cy), number(a.rx), number(a.ry));
    case "line":
      return `M${number(a.x1)} ${number(a.y1)}L${number(a.x2)} ${number(a.y2)}`;
    case "rect":
      return rect(a);
    case "polyline":
      return points(a.points, false);
    case "polygon":
      return points(a.points, true);
    default:
      throw new Error(`an icon element this script does not know: ${tag}`);
  }
}

function main() {
  const source = process.argv[2];
  if (source === undefined) {
    throw new Error("usage: node scripts/graph-icons.mjs <unpacked lucide-static package>");
  }
  const nodes = JSON.parse(readFileSync(resolve(source, "icon-nodes.json"), "utf8"));
  const tags = JSON.parse(readFileSync(resolve(source, "tags.json"), "utf8"));
  const version = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8")).version;
  const names = [
    ...new Set(readFileSync(resolve(iconsDir, "names.txt"), "utf8").split(/\s+/).filter(Boolean)),
  ].sort();
  const missing = names.filter((name) => !Object.hasOwn(nodes, name));
  if (missing.length > 0) {
    throw new Error(`not in lucide-static ${version}: ${missing.join(", ")}`);
  }
  const icons = {};
  for (const name of names) {
    icons[name] = {
      d: nodes[name].map(toPath).join(""),
      tags: (tags[name] ?? []).slice(0, 12),
    };
  }
  writeFileSync(
    resolve(iconsDir, "lucide.json"),
    `${JSON.stringify({ source: `lucide-static ${version}`, icons })}\n`,
  );
  writeFileSync(resolve(iconsDir, "LICENSE"), readFileSync(resolve(source, "LICENSE"), "utf8"));
  process.stdout.write(`${names.length} icons from lucide-static ${version}
`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
