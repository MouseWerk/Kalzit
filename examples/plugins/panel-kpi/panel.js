// KPI tile: an example panel plugin for Kalzit, speaking the panel message API version 1
// (plugin-api/panel/v1/kalzit-panel.d.ts). It shows the latest value of a number field, the
// change against the value before it, and a sparkline of the field.
//
// Options (the panel's JSON options): { "field": "cpu", "decimals": 1, "label": "CPU" }; all
// optional. Without `field` the first number field of the first frame is shown.
//
// The bundle runs in a sandboxed iframe without network: everything it needs is in this file,
// and it reaches Kalzit only through postMessage.

/** @typedef {import("../../../plugin-api/panel/v1/kalzit-panel").PanelMessage} PanelMessage */
/** @typedef {import("../../../plugin-api/panel/v1/kalzit-panel").PanelEvent} PanelEvent */

const API = 1;
const SVG = "http://www.w3.org/2000/svg";

const state = {
  options: {},
  locale: "en",
  title: "",
  series: [],
  /** The row index of the shown value, for clicks. */
  shown: null,
};

/** @param {Omit<PanelEvent, "kalzit" | "api">} event */
function send(event) {
  window.parent.postMessage({ kalzit: "panel", api: API, ...event }, "*");
}

const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; background: var(--bg-raised); color: var(--text); font-family: var(--font-sans); }
  .tile { box-sizing: border-box; height: 100%; display: grid; grid-template-rows: auto 1fr auto; padding: var(--space-3); gap: var(--space-1); cursor: default; }
  .tile[data-clickable] { cursor: pointer; }
  .label { font-size: var(--font-size-sm); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .value { font-size: var(--font-size-display); font-weight: var(--font-weight-semibold); font-variant-numeric: tabular-nums; align-self: center; line-height: 1.1; }
  .unit { font-size: var(--font-size-md); font-weight: var(--font-weight-regular); color: var(--text-muted); margin-inline-start: var(--space-1); }
  .delta { font-size: var(--font-size-sm); font-variant-numeric: tabular-nums; color: var(--text-muted); }
  .delta[data-sign="up"] { color: var(--success-text); }
  .delta[data-sign="down"] { color: var(--danger-text); }
  svg { width: 100%; height: 2.5rem; display: block; }
  polyline { fill: none; stroke: var(--text-muted); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .empty { color: var(--text-muted); font-size: var(--font-size-sm); align-self: center; }
`;
document.head.append(style);

const tile = document.createElement("div");
tile.className = "tile";
const label = document.createElement("div");
label.className = "label";
const value = document.createElement("div");
value.className = "value";
const delta = document.createElement("div");
delta.className = "delta";
const spark = document.createElementNS(SVG, "svg");
spark.setAttribute("viewBox", "0 0 100 30");
spark.setAttribute("preserveAspectRatio", "none");
spark.setAttribute("aria-hidden", "true");
const line = document.createElementNS(SVG, "polyline");
spark.append(line);
const footer = document.createElement("div");
footer.append(delta, spark);
tile.append(label, value, footer);
document.body.append(tile);

const texts = {
  en: { noData: "No data", noField: "No number field" },
  de: { noData: "Keine Daten", noField: "Kein Zahlenfeld" },
};

function text(key) {
  return (texts[state.locale] ?? texts.en)[key];
}

/** The frame and field to show: the option `field`, else the first number field. */
function pick() {
  for (const s of state.series) {
    const frame = s.result?.shape === "frame" ? s.result.frame : null;
    if (!frame) continue;
    const field = frame.fields.find((f) =>
      state.options.field ? f.name === state.options.field : f.type === "number" || f.type === "int64" || f.type === "decimal",
    );
    if (field) return { refId: s.refId, field };
  }
  return null;
}

function format(n) {
  const decimals = Number.isInteger(state.options.decimals) ? Math.min(Math.max(state.options.decimals, 0), 10) : undefined;
  return new Intl.NumberFormat(state.locale, { maximumFractionDigits: decimals ?? 2, minimumFractionDigits: decimals ?? 0 }).format(n);
}

function render() {
  const picked = pick();
  label.textContent = state.options.label || state.title || picked?.field.name || "";
  value.replaceChildren();
  delta.textContent = "";
  delta.removeAttribute("data-sign");
  line.setAttribute("points", "");
  state.shown = null;
  tile.removeAttribute("data-clickable");
  if (!picked) {
    value.className = "empty";
    value.textContent = state.series.length ? text("noField") : text("noData");
    return;
  }
  value.className = "value";
  const numbers = [];
  picked.field.values.forEach((v, i) => {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) numbers.push({ n, i });
  });
  if (numbers.length === 0) {
    value.className = "empty";
    value.textContent = text("noData");
    return;
  }
  const last = numbers[numbers.length - 1];
  state.shown = { refId: picked.refId, index: last.i };
  tile.setAttribute("data-clickable", "");
  value.append(format(last.n));
  if (picked.field.unit) {
    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = picked.field.unit;
    value.append(unit);
  }
  if (numbers.length > 1) {
    const change = last.n - numbers[numbers.length - 2].n;
    delta.textContent = `${change > 0 ? "+" : ""}${format(change)}`;
    if (change !== 0) delta.setAttribute("data-sign", change > 0 ? "up" : "down");
    // A loop, not Math.min(...values): a long series would overflow the argument list.
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const p of numbers) {
      if (p.n < min) min = p.n;
      if (p.n > max) max = p.n;
    }
    const span = max - min || 1;
    const points = numbers.map((p, k) => `${((k / (numbers.length - 1)) * 100).toFixed(2)},${(28 - ((p.n - min) / span) * 26).toFixed(2)}`);
    line.setAttribute("points", points.join(" "));
  }
}

function applyTheme(theme) {
  if (!theme) return;
  document.documentElement.style.colorScheme = theme.scheme === "dark" ? "dark" : "light";
  for (const [name, val] of Object.entries(theme.tokens ?? {})) {
    if (name.startsWith("--") && typeof val === "string") document.documentElement.style.setProperty(name, val);
  }
}

tile.addEventListener("click", () => {
  if (state.shown) send({ type: "click", refId: state.shown.refId, target: "row", index: state.shown.index });
});

window.addEventListener("message", (event) => {
  // Only Kalzit, the parent window, speaks to the panel.
  if (event.source !== window.parent) return;
  /** @type {PanelMessage} */
  const m = event.data;
  if (!m || m.kalzit !== "panel" || m.api !== API) return;
  switch (m.type) {
    case "init":
      state.options = m.options ?? {};
      state.locale = m.locale === "de" ? "de" : "en";
      state.title = m.title ?? "";
      applyTheme(m.theme);
      break;
    case "data":
      state.series = Array.isArray(m.series) ? m.series : [];
      break;
    case "options":
      state.options = m.options ?? {};
      break;
    case "theme":
      applyTheme(m);
      break;
    case "state":
      tile.style.opacity = m.loading ? "0.6" : "";
      return;
    default:
      // Sizes and types of newer versions: nothing to do.
      return;
  }
  render();
});

send({ type: "ready" });
