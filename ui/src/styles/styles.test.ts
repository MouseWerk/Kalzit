import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
    /--(accent(-strong|-soft|-text|-hover)?|on-accent|success(-[\w-]+)?|warning(-[\w-]+)?|danger(-[\w-]+)?|info(-[\w-]+)?|tone(-[\w-]+)?)\b/;

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
          // Threshold tones (--tone, --tone-ok, ...) are status colors as well.
          expect(/--(success|warning|danger|info|tone)\b/.test(value), where(rule, property)).toBe(
            false,
          );
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

  it("lets long navigation labels shrink with the sidebar: entries truncate, sub-pages wrap", () => {
    const base = (selector: string) =>
      rules
        .filter(
          (rule) =>
            rule.context.length === 1 &&
            rule.selector.split(",").some((part) => part.trim() === selector),
        )
        .flatMap((rule) => rule.declarations);
    for (const grid of [".shell__nav-list", ".nav-sub", ".nav-sub__group", ".nav-sub__list"]) {
      expect(base(grid), grid).toContainEqual({
        property: "grid-template-columns",
        value: "minmax(0, 1fr)",
      });
    }
    const sublink = rules.find((rule) => rule.selector === ".nav-sublink")?.declarations ?? [];
    expect(sublink).toContainEqual({ property: "white-space", value: "normal" });
    expect(sublink).toContainEqual({ property: "padding-block", value: "var(--space-1)" });
    expect(sublink).toContainEqual({ property: "line-height", value: "var(--line-height-tight)" });
    const label = base(".nav-link__label");
    expect(label).toContainEqual({ property: "text-overflow", value: "ellipsis" });
    expect(label).toContainEqual({ property: "min-width", value: "0" });
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
  const LAYOUT =
    /\b(width|height|margin|padding|top|left|right|bottom|inset|font-size|all|grid-template|grid|flex-basis|flex|gap|min-width|max-width|inline-size|block-size|line-height|letter-spacing|border-width|aspect-ratio)\b/;
  const ANIMATED = /^(transition|transition-property|animation|animation-name|will-change)$/;

  /** Every declaration that animates a layout property, as "selector { property: value }". */
  function layoutAnimations(rules: (StyleRule & { file?: string })[]): string[] {
    const found: string[] = [];
    for (const rule of rules) {
      // Keyframes animate whatever they declare.
      const keyframes = rule.context.some((context) => context.startsWith("@keyframes"));
      for (const { property, value } of rule.declarations) {
        if (
          (ANIMATED.test(property) && LAYOUT.test(value)) ||
          (keyframes && LAYOUT.test(property))
        ) {
          found.push(`${rule.selector} { ${property}: ${value} }`);
        }
      }
    }
    return found;
  }

  it("animates no layout properties", () => {
    expect(layoutAnimations(allRules())).toEqual([]);
  });

  it("catches layout properties in transitions, animation hints and keyframes", () => {
    const sample = parseCss(
      "@layer components { .a { transition: line-height 1s, color 1s; } .b { will-change: letter-spacing; transition: background-color 1s; } @keyframes grow { to { aspect-ratio: 2; color: red; } } }",
    );
    expect(layoutAnimations(sample).map((found) => found.split(" { ")[1])).toEqual([
      "transition: line-height 1s, color 1s }",
      "will-change: letter-spacing }",
      "aspect-ratio: 2 }",
    ]);
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
    expect(zeroed).toEqual([
      "--duration-fast: 0ms",
      "--duration-normal: 0ms",
      "--duration-pulse: 0ms",
    ]);
    // Each zeroing block must come after the block that declares the duration, or it loses.
    const tokenRules = rulesByFile.find(({ name }) => name === TOKENS_FILE)?.rules ?? [];
    for (const rule of reduced ?? []) {
      for (const { property } of rule.declarations) {
        const declared = tokenRules.findLastIndex(
          (r) =>
            r.selector === ":root" &&
            r.context.length === 1 &&
            r.declarations.some((d) => d.property === property),
        );
        expect(tokenRules.indexOf(rule), property).toBeGreaterThan(declared);
      }
    }
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

  it("loads nothing from other hosts", () => {
    for (const { name, source } of files) {
      expect(remoteLoads(source), name).toEqual([]);
    }
  });

  it("catches remote loads in url() and in @import, in any case", () => {
    for (const source of [
      '.a { background: url("https://example.com/a.png"); }',
      ".a { background: URL(//example.com/a.png); }",
      '@import "https://example.com/a.css";',
      "@import '//example.com/a.css';",
      '@IMPORT "HTTPS://example.com/a.css";',
      "@import url(https://example.com/a.css);",
      '.a { background: image-set("https://example.com/a.png" 1x, "./a2.png" 2x); }',
      ".a { background: -webkit-IMAGE-SET('//example.com/a.png' 1x); }",
      '.a { background: image-set(url("https://example.com/a.png") 1x); }',
    ]) {
      expect(remoteLoads(source), source).toHaveLength(1);
    }
    expect(remoteLoads('@import "./tokens.css"; .a { background: url("./a.png"); }')).toEqual([]);
    expect(
      remoteLoads('.a { background: image-set("./a.png" 1x, "a2.png" type("image/png")); }'),
    ).toEqual([]);
  });

  it("loads fonts only from the bundled, licensed files declared in tokens.css", () => {
    const disk = {
      exists: existsSync,
      list: (dir: string) => (existsSync(dir) ? readdirSync(dir) : []),
    };
    expect(fontViolations(files, disk)).toEqual([]);
  });

  it("catches every way a font could break the bundling rule", () => {
    const fonts = resolve(SRC_DIR, "assets/fonts");
    const disk = {
      exists: (path: string) => resolve(path) === resolve(fonts, "a.woff2"),
      list: () => ["OFL-a.txt"],
    };
    const face = (body: string, at = "@font-face") =>
      `@layer tokens { ${at} { font-family: "A"; ${body} } }`;
    const good = 'font-display: swap; src: url("../assets/fonts/a.woff2") format("woff2");';
    const check = (name: string, source: string) => fontViolations([{ name, source }], disk);
    const notBundled = (url: string) =>
      `styles/tokens.css: font file ${url} is not a bundled woff2 under src/assets/fonts`;

    expect(check(TOKENS_FILE, face(good))).toEqual([]);
    expect(check(TOKENS_FILE, face('font-display: swap; src: local("Arial");'))).toEqual([]);
    // A: a face outside tokens.css; B: the same, spelled in capitals.
    expect(check("features/x/x.css", face(good))).toEqual([
      "features/x/x.css: @font-face outside styles/tokens.css",
    ]);
    expect(check("features/x/x.css", face(good, "@FONT-FACE"))).toEqual([
      "features/x/x.css: @font-face outside styles/tokens.css",
    ]);
    // C, D: no swap.
    expect(check(TOKENS_FILE, face('src: url("../assets/fonts/a.woff2");'))).toEqual([
      "styles/tokens.css: @font-face without font-display: swap",
    ]);
    expect(
      check(TOKENS_FILE, face('font-display: block; src: url("../assets/fonts/a.woff2");')),
    ).toEqual(["styles/tokens.css: @font-face without font-display: swap"]);
    // E: files that are not bundled woff2.
    for (const url of [
      "https://fonts.example.com/a.woff2",
      "//fonts.example.com/a.woff2",
      "/assets/fonts/a.woff2",
      "data:font/woff2;base64,AAAA",
      "../assets/a.woff2",
      "../assets/fonts/b.woff2",
      "../assets/fonts/a.ttf",
    ]) {
      expect(check(TOKENS_FILE, face(`font-display: swap; src: url("${url}");`)), url).toEqual([
        notBundled(url),
      ]);
    }
    // F: a second src or font-display would win over the first one.
    expect(check(TOKENS_FILE, face(`${good} src: url("../assets/fonts/a.woff2");`))).toEqual([
      "styles/tokens.css: @font-face declares src more than once",
    ]);
    expect(check(TOKENS_FILE, face(`${good} font-display: swap;`))).toEqual([
      "styles/tokens.css: @font-face declares font-display more than once",
    ]);
    // G: url() in capitals.
    expect(
      check(TOKENS_FILE, face('font-display: swap; src: URL("data:font/woff2;base64,AAAA");')),
    ).toEqual([notBundled("data:font/woff2;base64,AAAA")]);
    // H: no license next to the file; I: no license in the release bundle.
    const publicDir = resolve(SRC_DIR, "../public/licenses/fonts");
    const noLicense = {
      ...disk,
      list: (dir: string) => (dir === fonts ? ["OFL-b.txt", "README.md"] : ["OFL-a.txt"]),
    };
    expect(fontViolations([{ name: TOKENS_FILE, source: face(good) }], noLicense)).toEqual([
      "styles/tokens.css: font file ../assets/fonts/a.woff2 has no license file next to it",
    ]);
    const notShipped = {
      ...disk,
      list: (dir: string) => (dir === publicDir ? ["OFL-b.txt"] : ["OFL-a.txt"]),
    };
    expect(fontViolations([{ name: TOKENS_FILE, source: face(good) }], notShipped)).toEqual([
      "styles/tokens.css: font file ../assets/fonts/a.woff2 has no license in public/licenses/fonts",
    ]);
  });

  it("gives the fallback faces the measured metrics of the bundled faces", () => {
    // Measured with fontTools (see the comment at the fallback faces in tokens.css).
    const measured: Record<string, Record<string, string>> = {
      '"Instrument Sans Fallback"': {
        "size-adjust": "102.8%",
        "ascent-override": "94.4%",
        "descent-override": "24.3%",
      },
      '"Newsreader Fallback"': {
        "size-adjust": "96.7%",
        "ascent-override": "76%",
        "descent-override": "27.4%",
      },
    };
    const tokens = rulesByFile.find(({ name }) => name === TOKENS_FILE)?.rules ?? [];
    for (const [family, metrics] of Object.entries(measured)) {
      const face = tokens.find(
        (rule) =>
          rule.selector === "@font-face" &&
          rule.declarations.some((d) => d.property === "font-family" && d.value === family),
      );
      for (const [property, value] of Object.entries(metrics)) {
        expect(
          face?.declarations.find((d) => d.property === property)?.value,
          `${family} ${property}`,
        ).toBe(value);
      }
    }
  });

  it("sizes menus and the rail's flyout from the menu tokens", () => {
    const rules = rulesByFile.find(({ name }) => name === "styles/components.css")?.rules ?? [];
    const widths = rules
      .filter((rule) => [".menu", ".nav-flyout"].includes(rule.selector))
      .flatMap((rule) => rule.declarations)
      .filter((d) => /^(min-|max-)?width$/.test(d.property));
    expect(widths.length).toBeGreaterThan(0);
    for (const { property, value } of widths) {
      expect(value, property).toMatch(/var\(--size-menu-(min|max)\)/);
    }
  });

  it("colors native check boxes and radios with the text color", () => {
    const rules = rulesByFile.find(({ name }) => name === "styles/base.css")?.rules ?? [];
    for (const type of ["checkbox", "radio"]) {
      const rule = rules.find((r) =>
        r.selector.split(",").some((part) => part.trim() === `input[type="${type}"]`),
      );
      expect(rule?.declarations, type).toContainEqual({
        property: "accent-color",
        value: "var(--text)",
      });
    }
  });
});

/** Every url() or @import of a stylesheet that reaches another host (a scheme or `//`). */
function remoteLoads(source: string): string[] {
  const css = stripComments(source);
  const remote = /^\s*["']?\s*([a-z][\w+.-]*:|\/\/)/i;
  const found: string[] = [];
  for (const [, target = ""] of css.matchAll(/url\(([^)]*)\)/gi)) {
    if (remote.test(target)) found.push(`url(${target})`);
  }
  for (const [, target = ""] of css.matchAll(/@import\s+("[^"]*"|'[^']*')/gi)) {
    if (remote.test(target)) found.push(`@import ${target}`);
  }
  // image-set() also takes plain strings as image addresses (url() inside it is caught above).
  for (const [, inner = ""] of css.matchAll(/image-set\(((?:[^()]|\([^()]*\))*)\)/gi)) {
    for (const [target] of inner.replace(/url\([^)]*\)/gi, "").matchAll(/"[^"]*"|'[^']*'/g)) {
      if (remote.test(target)) found.push(`image-set ${target}`);
    }
  }
  return found;
}

/**
 * Fonts are bundled with the app (the server runs offline): faces only in tokens.css, each with
 * one font-display: swap and one src, each file a woff2 under src/assets/fonts that exists, with
 * its family's license (OFL-<family>.txt) next to it and in public/licenses/fonts, which ships in
 * the release. The file system is injectable so the guard itself can be tested.
 */
function fontViolations(
  sheets: { name: string; source: string }[],
  disk: { exists: (path: string) => boolean; list: (dir: string) => string[] },
): string[] {
  const fontsDir = resolve(SRC_DIR, "assets/fonts");
  const publicDir = resolve(SRC_DIR, "../public/licenses/fonts");
  const found: string[] = [];
  for (const { name, source } of sheets) {
    for (const rule of parseCss(source)) {
      if (rule.selector.toLowerCase() !== "@font-face") {
        continue;
      }
      if (name !== TOKENS_FILE) {
        found.push(`${name}: @font-face outside ${TOKENS_FILE}`);
        continue;
      }
      const all = (property: string) =>
        rule.declarations.filter((d) => d.property === property).map((d) => d.value);
      for (const property of ["src", "font-display"]) {
        if (all(property).length > 1) {
          found.push(`${name}: @font-face declares ${property} more than once`);
        }
      }
      if (all("font-display").at(-1)?.toLowerCase() !== "swap") {
        found.push(`${name}: @font-face without font-display: swap`);
      }
      for (const src of all("src")) {
        for (const [, url = ""] of src.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/gi)) {
          const path = resolve(SRC_DIR, dirname(name), url);
          const bundled =
            url.startsWith(".") &&
            url.endsWith(".woff2") &&
            dirname(path) === fontsDir &&
            disk.exists(path);
          if (!bundled) {
            found.push(`${name}: font file ${url} is not a bundled woff2 under src/assets/fonts`);
            continue;
          }
          // OFL-instrument-sans.txt covers instrument-sans-*.woff2.
          const file = basename(path);
          const covers = (license: string) => {
            const family = /^OFL-(.+)\.txt$/.exec(license)?.[1];
            return (
              family !== undefined &&
              (file.startsWith(`${family}-`) || file.startsWith(`${family}.`))
            );
          };
          if (!disk.list(fontsDir).some(covers)) {
            found.push(`${name}: font file ${url} has no license file next to it`);
          } else if (!disk.list(publicDir).some(covers)) {
            found.push(`${name}: font file ${url} has no license in public/licenses/fonts`);
          }
        }
      }
    }
  }
  return found;
}

describe("contrast in every theme", () => {
  const tokenRules = rulesByFile.find(({ name }) => name === TOKENS_FILE)?.rules ?? [];

  // Every top-level block of the selector, in file order: areas append their tokens in blocks of
  // their own, and those are checked like the first.
  function declarationsOf(selector: string): Map<string, string> {
    const rules = tokenRules.filter((r) => r.selector === selector && r.context.length === 1);
    return new Map(rules.flatMap((rule) => rule.declarations.map((d) => [d.property, d.value])));
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
    ["--success-text", ["--bg", "--bg-surface", "--bg-raised", "--success-bg"], TEXT],
    ["--warning-text", ["--bg", "--bg-surface", "--bg-raised", "--warning-bg"], TEXT],
    ["--info-text", ["--bg", "--bg-surface", "--bg-raised", "--info-bg"], TEXT],
    ["--text", ["--success-bg", "--warning-bg", "--info-bg"], TEXT],
    // Non-text UI that carries meaning: input borders, the focus ring, the primary button fill.
    ["--border-strong", ["--bg", "--bg-surface", "--bg-raised"], UI],
    ["--focus-ring", ["--bg", "--bg-surface", "--bg-raised", "--bg-hover", "--bg-active"], UI],
    ["--accent", ["--bg", "--bg-surface", "--bg-raised"], UI],
    // Threshold states are marks on the panel surfaces (gauge arcs, bars, cells, large values).
    ...["--tone-ok", "--tone-warn", "--tone-critical"].map(
      (name) => [name, ["--bg", "--bg-surface", "--bg-raised"], UI] as [string, string[], number],
    ),
    // Text sits on the tinted fills of colored stats and table cells.
    ...["--text", "--text-muted"].map(
      (name) =>
        [
          name,
          [
            "--tone-ok-bg",
            "--tone-warn-bg",
            "--tone-critical-bg",
            ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `--chart-${n}-bg`),
          ],
          TEXT,
        ] as [string, string[], number],
    ),
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

  // Threshold states must be told apart without color vision too; they also carry a name for
  // screen readers, but on the screen the color is what shows the state.
  for (const scheme of ["light", "dark"] as const) {
    it(`keeps threshold states distinguishable for every color vision (${scheme})`, () => {
      const states = ["ok", "warn", "critical"].map((name) =>
        resolveColor(base, scheme, `--tone-${name}`),
      );
      const tooClose: string[] = [];
      for (const vision of VISIONS) {
        for (let i = 0; i < states.length; i++) {
          for (let j = i + 1; j < states.length; j++) {
            const distance = perceivedDistance(states[i] ?? "", states[j] ?? "", vision);
            if (distance < NEIGHBOURS_APART) {
              tooClose.push(`${vision} ${i}/${j}: ${distance.toFixed(1)}`);
            }
          }
        }
      }
      expect(tooClose).toEqual([]);
    });

    it(`grows the heat ramp steadily away from the surface (${scheme})`, () => {
      const surface = resolveColor(base, scheme, "--bg-surface");
      const ramp = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => resolveColor(base, scheme, `--heat-${n}`));
      const contrast = ramp.map((color) => contrastRatio(color, surface));
      for (let i = 1; i < contrast.length; i++) {
        expect(contrast[i] ?? 0, `heat-${i + 1} after heat-${i}`).toBeGreaterThan(
          contrast[i - 1] ?? 0,
        );
      }
      // The strongest step is a mark that must stand out like a series color.
      expect(contrast.at(-1) ?? 0).toBeGreaterThanOrEqual(UI);
      for (const vision of VISIONS) {
        for (let i = 1; i < ramp.length; i++) {
          expect(
            perceivedDistance(ramp[i] ?? "", ramp[i - 1] ?? "", vision),
            `${vision} heat-${i}/heat-${i + 1}`,
          ).toBeGreaterThanOrEqual(SERIES_APART);
        }
      }
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
