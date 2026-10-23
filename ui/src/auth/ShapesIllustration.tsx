import { useId } from "react";
import { useI18n } from "../i18n/i18n";
import "./auth.css";

// The three native result shapes, drawn in the monochrome chart style of the app: a time series
// with a hatch under its line and a dashed comparison, a document tree and a graph with one path
// drawn strong. No figures and no axis values: it shows shapes, not data.

const LINE = "M16 110C48 106 70 90 104 94S150 68 184 76 236 102 268 84 330 50 384 56";
const AREA = `${LINE}L384 128 16 128Z`;
const COMPARE = "M16 120C50 118 80 108 110 111S170 96 200 99 260 107 290 99 350 84 384 86";
const GRID = [56, 80, 104, 128];

// Field names of the sample document; schema words, the same in every language.
const TREE = [
  { depth: 0, key: "order", open: true, bar: 0 },
  { depth: 1, key: "customer", open: false, bar: 46 },
  { depth: 1, key: "items", open: true, bar: 0 },
  { depth: 2, key: "sku", open: false, bar: 52 },
  { depth: 2, key: "qty", open: false, bar: 22 },
] as const;

const NODES = [
  { id: "a", x: 238, y: 226, path: true },
  { id: "b", x: 290, y: 206, path: true },
  { id: "c", x: 344, y: 236, path: true },
  { id: "d", x: 258, y: 274, path: false },
  { id: "e", x: 318, y: 280, path: true },
  { id: "f", x: 374, y: 204, path: false },
  { id: "g", x: 376, y: 270, path: false },
] as const;

const EDGES = [
  ["a", "b", true],
  ["b", "c", true],
  ["c", "e", true],
  ["a", "d", false],
  ["d", "e", false],
  ["b", "f", false],
  ["f", "c", false],
  ["c", "g", false],
] as const;

function node(id: string) {
  return NODES.find((candidate) => candidate.id === id) ?? NODES[0];
}

export function ShapesIllustration() {
  const { t } = useI18n();
  const titleId = useId();
  // A React id may hold characters that url(#...) would have to escape; keep only safe ones.
  const hatchId = `hatch-${titleId.replace(/[^\w-]/g, "")}`;
  return (
    <svg
      className="shapes"
      viewBox="0 0 400 300"
      role="img"
      aria-labelledby={titleId}
      focusable="false"
    >
      <title id={titleId}>{t("auth.illustration")}</title>
      <defs>
        <pattern
          id={hatchId}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line className="shapes__hatch" x1="0" y1="0" x2="0" y2="6" />
        </pattern>
      </defs>

      <rect className="shapes__card" x="0.5" y="0.5" width="399" height="147" />
      <text className="shapes__label" x="16" y="28">
        {t("auth.shapeFrame")}
      </text>
      {GRID.map((y) => (
        <line key={y} className="shapes__grid" x1="16" x2="384" y1={y} y2={y} />
      ))}
      <path className="shapes__area" d={AREA} fill={`url(#${hatchId})`} />
      <path className="shapes__compare" d={COMPARE} />
      <path className="shapes__line" d={LINE} />

      <rect className="shapes__card" x="0.5" y="160.5" width="193" height="139" />
      <text className="shapes__label" x="16" y="188">
        {t("auth.shapeDocuments")}
      </text>
      {TREE.map((row, index) => {
        const x = 16 + row.depth * 14;
        const y = 212 + index * 18;
        return (
          <g key={row.key}>
            {row.bar === 0 ? (
              <path
                className="shapes__caret"
                d={row.open ? `M${x} ${y - 6}l4 4 4-4` : `M${x + 2} ${y - 8}l4 4-4 4`}
              />
            ) : null}
            <text className="shapes__key" x={x + 14} y={y}>
              {row.key}
            </text>
            {row.bar === 0 ? null : (
              <rect className="shapes__bar" x="112" y={y - 8} width={row.bar} height="8" />
            )}
          </g>
        );
      })}

      <rect className="shapes__card" x="206.5" y="160.5" width="193" height="139" />
      <text className="shapes__label" x="222" y="188">
        {t("auth.shapeGraph")}
      </text>
      {EDGES.map(([from, to, path]) => {
        const a = node(from);
        const b = node(to);
        return (
          <line
            key={`${from}-${to}`}
            className={path ? "shapes__edge shapes__edge--path" : "shapes__edge"}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
          />
        );
      })}
      {NODES.map((n) => (
        <circle
          key={n.id}
          className={n.path ? "shapes__node shapes__node--path" : "shapes__node"}
          cx={n.x}
          cy={n.y}
          r={n.path ? 6 : 4.5}
        />
      ))}
    </svg>
  );
}
