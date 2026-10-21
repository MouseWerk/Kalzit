import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, perceivedDistance, VISIONS } from "../test/contrast";
import { listCssFiles, parseCss, type StyleRule, stripComments } from "../test/cssParse";

/**
 * Design rules as tests (AICodeGuidelines design/guard-tests.md). Rules that are not tested come
 * back, so each rule of design/principles.md that can be read from the stylesheets is checked here.
 */

// Every stylesheet under src, not only src/styles: areas keep their CSS next to their code
// (features/<area>/...) and must follow the same rules. Names are paths relative to src.
const SRC_DIR = resolve(import.meta.dirname, "..");
const TOKENS_FILE = "styles/tokens.css";
const INDEX_FILE = "styles/index.css";
const LAYER_ORDER = ["reset", "tokens", "base", "components", "utilities"];

const files = listCssFiles(SRC_DIR).map((name) => ({
  name,
  source: readFileSync(resolve(SRC_DIR, name), "utf8"),
}));

const rulesByFile = files.map(({ name, source }) => ({ name, rules: parseCss(source) }));

function allRules(options: { exceptTokens?: boolean } = {}): (StyleRule & { file: string })[] {
  return rulesByFile
    .filter(({ name }) => !(options.exceptTokens === true && name === TOKENS_FILE))
    .flatMap(({ name, rules }) => rules.map((rule) => ({ ...rule, file: name })));
}

function where(rule: { file: string; selector: string }, property: string): string {
  return `${rule.file}: ${rule.selector} { ${property} }`;
}

describe("stylesheet integrity", () => {
  it("finds the stylesheets", () => {
    expect(files.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "styles/base.css",
        "styles/components.css",
        "styles/index.css",
        "styles/reset.css",
        "styles/tokens.css",
        "styles/utilities.css",
      ]),
    );
  });

  it("finds stylesheets in nested folders, such as an area's", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalzit-css-"));
    try {
      mkdirSync(join(dir, "features", "graph"), { recursive: true });
      writeFileSync(join(dir, "features", "graph", "graph.css"), "");
      writeFileSync(join(dir, "top.css"), "");
      writeFileSync(join(dir, "notes.txt"), "");
      expect(listCssFiles(dir)).toEqual(["features/graph/graph.css", "top.css"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(files)("$name has balanced braces and parentheses", ({ source }) => {
    const css = stripComments(source).replace(/"[^"]*"|'[^']*'/g, '""');
    expect(css.split("{").length).toBe(css.split("}").length);
    expect(css.split("(").length).toBe(css.split(")").length);
  });

  it.each(files)("$name has no merge conflict markers", ({ source }) => {
    expect(/^(<{7}|={7}|>{7})/m.test(source)).toBe(false);
  });

  it("declares the layer order before anything else", () => {
    const index = stripComments(files.find(({ name }) => name === INDEX_FILE)?.source ?? "");
    const first = index.trim().split(";")[0]?.replace(/\s+/g, " ");
    expect(first).toBe(`@layer ${LAYER_ORDER.join(", ")}`);
  });

  it("puts every rule of a file into that file's layer, area styles into components", () => {
    for (const { name, rules } of rulesByFile) {
      if (name === INDEX_FILE) {
        expect(rules).toHaveLength(0);
        continue;
      }
      const layer = name.startsWith("styles/")
        ? name.replace(/^styles\//, "").replace(/\.css$/, "")
        : "components";
      expect(LAYER_ORDER).toContain(layer);
      for (const rule of rules) {
        expect(rule.context[0], `${name}: ${rule.selector}`).toBe(`@layer ${layer}`);
      }
    }
  });
});

describe("tokens only", () => {
  const LITERAL_COLOR =
    /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(|\b(white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink)\b/i;

  it("keeps literal colors in tokens.css", () => {
    for (const rule of allRules({ exceptTokens: true })) {
      for (const { property, value } of rule.declarations) {
        expect(LITERAL_COLOR.test(value), where(rule, `${property}: ${value}`)).toBe(false);
      }
    }
  });

  it("takes font weights, layers and radii from tokens", () => {
    const tokenOnly: Record<string, RegExp> = {
      "font-weight": /^var\(--font-weight-[\w-]+\)$/,
      "z-index": /^var\(--z-[\w-]+\)$/,
      "border-radius": /^(0|var\(--radius-[\w-]+\))( (0|var\(--radius-[\w-]+\)))*$/,
    };
    for (const rule of allRules({ exceptTokens: true })) {
      for (const { property, value } of rule.declarations) {
        const pattern = tokenOnly[property];
        if (pattern !== undefined) {
          expect(pattern.test(value), where(rule, `${property}: ${value}`)).toBe(true);
        }
      }
    }
  });

  it("takes spacing from tokens", () => {
    const SPACING = /^(margin|padding|gap|row-gap|column-gap)(-[\w-]+)?$/;
    const part = /^(0|auto|var\(--space-[\w-]+\)|calc\(.*var\(--space-[\w-]+\).*\))$/;
    for (const rule of allRules({ exceptTokens: true })) {
      for (const { property, value } of rule.declarations) {
        if (SPACING.test(property)) {
          for (const piece of value.split(/ (?![^(]*\))/)) {
            expect(part.test(piece), where(rule, `${property}: ${value}`)).toBe(true);
          }
        }
      }
    }
  });

  it("takes font sizes from tokens", () => {
    for (const rule of allRules({ exceptTokens: true })) {
      for (const { property, value } of rule.declarations) {
        if (property === "font-size") {
          expect(
            /^(var\(--font-size-[\w-]+\)|100%|\d*\.?\d+em)$/.test(value),
            where(rule, `${property}: ${value}`),
          ).toBe(true);
        }
      }
    }
  });

  it("draws the focus ring only from the focus token", () => {
    for (const rule of allRules({ exceptTokens: true })) {
      for (const { property, value } of rule.declarations) {
        if (property === "outline") {
          expect(value, where(rule, property)).toBe("var(--focus-outline)");
        }
        expect(
          ["outline-color", "outline-style", "outline-width"],
          where(rule, property),
        ).not.toContain(property);
      }
    }
  });

  it("styles focus only for :focus-visible (or :focus-within), never plain :focus", () => {
    for (const rule of allRules()) {
      expect(/:focus(?![-\w])/.test(rule.selector), rule.selector).toBe(false);
    }
  });
});

describe("no accent frames for states", () => {
  // From design/guard-tests.md.
  const STATE =
    /\.(active|selected|sel|current|on|checked|picked|now|today|focused|is-selected|is-editing|recording|running|live|playing)\b|:checked|:hover|:active|:focus(-visible|-within)?\b|\[aria-(selected|current|pressed|checked|expanded)/;
  const FRAME = /^(border(-[\w-]+)?|outline(-color)?|box-shadow)$/;
  const ACCENT =
    /--(accent(-strong|-soft|-text|-hover)?|on-accent|success(-[\w-]+)?|warning(-[\w-]+)?|danger(-[\w-]+)?|info(-[\w-]+)?)\b/;

  it("frames no hovered, focused, selected or current element in an accent or status color", () => {
    for (const rule of allRules()) {
      if (!STATE.test(rule.selector)) {
        continue;
      }
      for (const { property, value } of rule.declarations) {
        if (FRAME.test(property)) {
          expect(ACCENT.test(value), where(rule, `${property}: ${value}`)).toBe(false);
        }
      }
    }
  });

  it("puts status colors into text, icons and fills, never frames", () => {
    for (const rule of allRules({ exceptTokens: true })) {
      for (const { property, value } of rule.declarations) {
        if (FRAME.test(property) && property !== "box-shadow") {
          expect(/--(success|warning|danger|info)/.test(value), where(rule, property)).toBe(false);
        }
      }
    }
  });

  it("draws no colored bar on the left anywhere", () => {
    const LEFT = /^border-(left|inline-start)(-color|-width|-style)?$/;
    for (const rule of allRules()) {
      if (/\bblockquote\b/.test(rule.selector)) {
        continue;
      }
      for (const { property, value } of rule.declarations) {
        expect(LEFT.test(property) && value !== "0", where(rule, `${property}: ${value}`)).toBe(
          false,
        );
        if (property === "box-shadow") {
          // An inset shadow with a horizontal offset is a left bar in disguise.
          expect(/inset\s+-?\d/.test(value), where(rule, `${property}: ${value}`)).toBe(false);
        }
      }
    }
  });
});

describe("small screens", () => {
  const rules = rulesByFile.find(({ name }) => name === "styles/components.css")?.rules ?? [];
  const inMedia = (media: string, selector: string) =>
    rules.find((rule) => rule.selector === selector && rule.context.includes(media))
      ?.declarations ?? [];

  it("wraps the navigation instead of scrolling it, so no label is cut", () => {
    const list = inMedia("@media (max-width: 48rem)", ".shell__nav-list");
    expect(list).toContainEqual({ property: "flex-wrap", value: "wrap" });
    const nav = inMedia("@media (max-width: 48rem)", ".shell__nav");
    expect(nav.find((d) => d.property.startsWith("overflow"))?.value).toBe("visible");
  });

  it("uses the compact page padding for the whole single-column layout", () => {
    const main = inMedia("@media (max-width: 48rem)", ".shell__main");
    expect(main.some((d) => d.property === "padding")).toBe(true);
    // The phone query only turns navigation labels into icons; layout belongs to 48rem.
    const phone = rules
      .filter((rule) => rule.context.includes("@media (max-width: 25rem)"))
      .map((rule) => rule.selector);
    expect(phone.sort()).toEqual([".nav-link__label", ".shell__nav-list"]);
  });

  it("breaks only the sub-pages onto a line of their own, not their entry", () => {
    const group = rules.find(
      (rule) =>
        rule.context.includes("@media (max-width: 48rem)") &&
        rule.selector.split(",").some((part) => part.trim() === ".nav-group"),
    );
    expect(group?.declarations).toContainEqual({ property: "display", value: "contents" });
    expect(inMedia("@media (max-width: 48rem)", ".nav-sub")).toContainEqual({
      property: "flex",
      value: "1 0 100%",
    });
  });

  it("sets group headings apart from links with small capitals, not color", () => {
    const title = rules.find((rule) => rule.selector === ".nav-sub__title")?.declarations ?? [];
    expect(title).toContainEqual({ property: "text-transform", value: "uppercase" });
    expect(title).toContainEqual({
      property: "letter-spacing",
      value: "var(--letter-spacing-caps)",
    });
  });

  it("hides the rail's labels and the account name visually only, keeping them as names", () => {
    const declarationsFor = (selector: string) =>
      rules
        .filter((rule) =>
          rule.selector
            .split(",")
            .map((part) => part.replace(/\s+/g, " ").trim())
            .includes(selector),
        )
        .flatMap((rule) => rule.declarations);
    for (const selector of [
      '.shell[data-sidebar="collapsed"] .nav-link__label',
      '.shell[data-sidebar="collapsed"] .user-button__text',
    ]) {
      const declarations = declarationsFor(selector);
      expect(declarations, selector).toContainEqual({ property: "clip-path", value: "inset(50%)" });
      expect(
        declarations.some((d) => d.property === "display" && d.value === "none"),
        selector,
      ).toBe(false);
    }
  });

  it("shows only icons on phones, keeping the label for screen readers", () => {
    const label = inMedia("@media (max-width: 25rem)", ".nav-link__label");
    expect(label).toContainEqual({ property: "clip-path", value: "inset(50%)" });
    expect(label.some((d) => d.property === "display" && d.value === "none")).toBe(false);
  });
});

describe("motion and typography", () => {
  it("animates no layout properties", () => {
    const LAYOUT =
      /\b(width|height|margin|padding|top|left|right|bottom|inset|font-size|all|grid-template|grid|flex-basis|flex|gap|min-width|max-width|inline-size|block-size)\b/;
    for (const rule of allRules()) {
      for (const { property, value } of rule.declarations) {
        if (property === "transition" || property === "transition-property") {
          expect(LAYOUT.test(value), where(rule, `${property}: ${value}`)).toBe(false);
        }
      }
    }
  });

  it("uses duration tokens, which drop to zero for reduced motion", () => {
    for (const rule of allRules({ exceptTokens: true })) {
      for (const { property, value } of rule.declarations) {
        if (property.startsWith("transition") || property.startsWith("animation")) {
          expect(/\d+m?s\b/.test(value), where(rule, `${property}: ${value}`)).toBe(false);
        }
      }
    }
    const reduced = rulesByFile
      .find(({ name }) => name === TOKENS_FILE)
      ?.rules.filter((rule) => rule.context.some((c) => c.includes("prefers-reduced-motion")));
    const zeroed = reduced?.flatMap((rule) =>
      rule.declarations.map((d) => `${d.property}: ${d.value}`),
    );
    expect(zeroed).toEqual(["--duration-fast: 0ms", "--duration-normal: 0ms"]);
  });

  it("turns off ligatures wherever the mono font is used", () => {
    for (const rule of allRules({ exceptTokens: true })) {
      const mono = rule.declarations.some(
        (d) => d.property === "font-family" && d.value.includes("--font-mono"),
      );
      if (mono) {
        expect(
          rule.declarations.some(
            (d) => d.property === "font-variant-ligatures" && d.value === "none",
          ),
          rule.selector,
        ).toBe(true);
      }
    }
  });

  it("dims nothing with opacity, which would take text below AA", () => {
    for (const rule of allRules()) {
      for (const { property, value } of rule.declarations) {
        if (property === "opacity") {
          expect(Number(value), where(rule, `${property}: ${value}`)).toBe(1);
        }
      }
    }
  });

  it("never blocks the user's text zoom", () => {
    for (const rule of allRules()) {
      for (const { property, value } of rule.declarations) {
        if (property.endsWith("text-size-adjust")) {
          expect(value, where(rule, property)).not.toBe("none");
        }
      }
    }
  });

  it("loads no web fonts and nothing from other hosts", () => {
    for (const { name, source } of files) {
      expect(/@font-face|url\(\s*["']?(https?:)?\/\//.test(source), name).toBe(false);
    }
  });
});

describe("contrast in every theme", () => {
  const tokenRules = rulesByFile.find(({ name }) => name === TOKENS_FILE)?.rules ?? [];

  function declarationsOf(selector: string): Map<string, string> {
    const rule = tokenRules.find((r) => r.selector === selector && r.context.length === 1);
    return new Map(rule?.declarations.map((d) => [d.property, d.value]));
  }

  const base = declarationsOf(":root");
  const contrast = declarationsOf(':root[data-theme="contrast"]');
  // light and dark use the base tokens with a fixed scheme; system uses them with either scheme.
  const themes = [
    { name: "light", tokens: base, scheme: "light" },
    { name: "dark", tokens: base, scheme: "dark" },
    { name: "contrast (light system)", tokens: new Map([...base, ...contrast]), scheme: "light" },
    { name: "contrast (dark system)", tokens: new Map([...base, ...contrast]), scheme: "dark" },
  ] as const;

  function splitTopLevel(value: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of value) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (char === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    parts.push(current.trim());
    return parts;
  }

  function resolveColor(
    tokens: Map<string, string>,
    scheme: "light" | "dark",
    name: string,
  ): string {
    let value = tokens.get(name);
    for (let guard = 0; value !== undefined && guard < 10; guard++) {
      const lightDark = /^light-dark\((.*)\)$/.exec(value);
      if (lightDark !== null) {
        const [light, dark] = splitTopLevel(lightDark[1] ?? "");
        value = scheme === "light" ? light : dark;
        continue;
      }
      const reference = /^var\((--[\w-]+)\)$/.exec(value);
      if (reference !== null) {
        value = tokens.get(reference[1] ?? "");
        continue;
      }
      return value;
    }
    throw new Error(`cannot resolve ${name}`);
  }

  const TEXT = 4.5;
  const UI = 3;
  const pairs: [foreground: string, backgrounds: string[], minimum: number][] = [
    [
      "--text",
      ["--bg", "--bg-surface", "--bg-raised", "--bg-hover", "--bg-active", "--danger-bg"],
      TEXT,
    ],
    ["--text-muted", ["--bg", "--bg-surface", "--bg-raised", "--bg-hover", "--bg-active"], TEXT],
    ["--accent-text", ["--bg", "--bg-surface", "--bg-raised", "--danger-bg"], TEXT],
    ["--on-accent", ["--accent", "--accent-hover"], TEXT],
    ["--on-accent-busy", ["--accent-busy"], TEXT],
    ["--danger-text", ["--bg", "--bg-surface", "--bg-raised", "--danger-bg"], TEXT],
    ["--success-text", ["--bg", "--bg-surface", "--bg-raised"], TEXT],
    // Non-text UI that carries meaning: input borders, the focus ring, the primary button fill.
    ["--border-strong", ["--bg", "--bg-surface", "--bg-raised"], UI],
    ["--focus-ring", ["--bg", "--bg-surface", "--bg-raised", "--bg-hover", "--bg-active"], UI],
    ["--accent", ["--bg", "--bg-surface", "--bg-raised"], UI],
    // Chart series are meaningful marks on the panel surfaces.
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(
      (n) =>
        [`--chart-${n}`, ["--bg", "--bg-surface", "--bg-raised"], UI] as [string, string[], number],
    ),
  ];

  // Chart series must be told apart by everyone: every pair at least SERIES_APART and series that
  // usually sit next to each other at least NEIGHBOURS_APART, under normal vision and the three
  // common deficiencies (perceivedDistance: OKLab distance x100 after simulation).
  const SERIES_APART = 6;
  const NEIGHBOURS_APART = 12;
  for (const scheme of ["light", "dark"] as const) {
    it(`keeps chart series distinguishable for every color vision (${scheme})`, () => {
      const series = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
        resolveColor(base, scheme, `--chart-${n}`),
      );
      const tooClose: string[] = [];
      for (const vision of VISIONS) {
        for (let i = 0; i < series.length; i++) {
          for (let j = i + 1; j < series.length; j++) {
            const distance = perceivedDistance(series[i] ?? "", series[j] ?? "", vision);
            const minimum = j === i + 1 ? NEIGHBOURS_APART : SERIES_APART;
            if (distance < minimum) {
              tooClose.push(
                `${vision} chart-${i + 1}/chart-${j + 1}: ${distance.toFixed(1)} < ${minimum}`,
              );
            }
          }
        }
      }
      expect(tooClose).toEqual([]);
    });
  }

  for (const theme of themes) {
    it(`meets AA in the ${theme.name} theme`, () => {
      const failures: string[] = [];
      for (const [foreground, backgrounds, minimum] of pairs) {
        for (const background of backgrounds) {
          const ratio = contrastRatio(
            resolveColor(theme.tokens, theme.scheme, foreground),
            resolveColor(theme.tokens, theme.scheme, background),
          );
          if (ratio < minimum) {
            failures.push(`${foreground} on ${background}: ${ratio.toFixed(2)} < ${minimum}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("computes known ratios correctly", () => {
    expect(contrastRatio("oklch(0% 0 0)", "oklch(100% 0 0)")).toBeCloseTo(21, 1);
    expect(contrastRatio("oklch(100% 0 0)", "oklch(100% 0 0)")).toBeCloseTo(1, 5);
  });
});
