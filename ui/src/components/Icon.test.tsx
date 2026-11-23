import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  FACET,
  ICON_NAMES,
  Icon,
  type IconName,
  iconFacet,
  iconFills,
  iconMotion,
  iconPath,
  iconSmallPath,
  subpaths,
} from "./Icon";

/**
 * Keeps the icon set in one style (grid, size, centering, no duplicates) and its use accessible
 * (decorative icons hidden, icon-only buttons named).
 */

type Point = [number, number];

/** Points along an SVG path, curves and arcs sampled, for its bounding box. */
function samplePath(d: string): Point[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const points: Point[] = [];
  let i = 0;
  let command = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const num = () => Number(tokens[i++]);
  const curve = (pts: Point[]) => {
    for (let t = 0; t <= 1; t += 1 / 16) {
      // De Casteljau over the control points.
      let layer = pts;
      while (layer.length > 1) {
        layer = layer.slice(1).map((p, k) => {
          const q = layer[k] as Point;
          return [q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t] as Point;
        });
      }
      points.push(layer[0] as Point);
    }
  };
  const arc = (
    rx: number,
    ry: number,
    rot: number,
    large: number,
    sweep: number,
    ex: number,
    ey: number,
  ) => {
    // Endpoint to center parameterization (SVG 1.1, F.6.5), rotation 0 in every icon.
    expect(rot).toBe(0);
    const dx = (x - ex) / 2;
    const dy = (y - ey) / 2;
    const lambda = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const sign = large === sweep ? -1 : 1;
    const num2 = rx * rx * ry * ry - rx * rx * dy * dy - ry * ry * dx * dx;
    const coef = sign * Math.sqrt(Math.max(0, num2 / (rx * rx * dy * dy + ry * ry * dx * dx)));
    const cx = coef * ((rx * dy) / ry) + (x + ex) / 2;
    const cy = coef * (-(ry * dx) / rx) + (y + ey) / 2;
    const a1 = Math.atan2((y - cy) / ry, (x - cx) / rx);
    let delta = Math.atan2((ey - cy) / ry, (ex - cx) / rx) - a1;
    if (sweep && delta < 0) delta += 2 * Math.PI;
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    for (let k = 0; k <= 32; k++) {
      const a = a1 + (delta * k) / 32;
      points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
  };
  let lastControl: Point | null = null;
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i] ?? "")) {
      command = tokens[i++] ?? "";
    }
    const rel = command === command.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    let control: Point | null = null;
    switch (command.toLowerCase()) {
      case "m":
        x = num() + ox;
        y = num() + oy;
        startX = x;
        startY = y;
        points.push([x, y]);
        command = rel ? "l" : "L";
        break;
      case "l":
        x = num() + ox;
        y = num() + oy;
        points.push([x, y]);
        break;
      case "h":
        x = num() + ox;
        points.push([x, y]);
        break;
      case "v":
        y = num() + oy;
        points.push([x, y]);
        break;
      case "c": {
        const c1: Point = [num() + ox, num() + oy];
        const c2: Point = [num() + ox, num() + oy];
        const end: Point = [num() + ox, num() + oy];
        curve([[x, y], c1, c2, end]);
        control = c2;
        [x, y] = end;
        break;
      }
      case "s": {
        const c1: Point =
          lastControl === null ? [x, y] : [2 * x - lastControl[0], 2 * y - lastControl[1]];
        const c2: Point = [num() + ox, num() + oy];
        const end: Point = [num() + ox, num() + oy];
        curve([[x, y], c1, c2, end]);
        control = c2;
        [x, y] = end;
        break;
      }
      case "a": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num();
        const sweep = num();
        const ex = num() + ox;
        const ey = num() + oy;
        arc(rx, ry, rot, large, sweep, ex, ey);
        x = ex;
        y = ey;
        break;
      }
      case "z":
        x = startX;
        y = startY;
        break;
      default:
        throw new Error(`path command ${command} is not supported by the icon test`);
    }
    lastControl = control;
  }
  return points;
}

function box(d: string) {
  const points = samplePath(d);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

describe("the icon set", () => {
  it("keeps every drawing inside the live area of the 24 px grid", () => {
    const outside = ICON_NAMES.filter((name) => {
      const b = box(iconPath(name));
      return b.x0 < 2.9 || b.y0 < 1.9 || b.x1 > 21.1 || b.y1 > 22.1;
    });
    // Only the brand mark reaches past 3..21 vertically: it is drawn as on the website.
    expect(outside).toEqual([]);
    const tall = ICON_NAMES.filter((name) => {
      const b = box(iconPath(name));
      return name !== "logo" && (b.y0 < 2.9 || b.y1 > 21.1);
    });
    expect(tall).toEqual([]);
  });

  it("centers every drawing on the grid, so icons line up next to each other and to text", () => {
    const offCenter = ICON_NAMES.flatMap((name) => {
      const b = box(iconPath(name));
      return Math.abs(b.cx - 12) > 0.6 || Math.abs(b.cy - 12) > 0.6
        ? [`${name} ${b.cx.toFixed(2)},${b.cy.toFixed(2)}`]
        : [];
    });
    expect(offCenter).toEqual([]);
  });

  it("draws each picture once (the filled star is the outlined one, filled)", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const name of ICON_NAMES) {
      const d = iconPath(name);
      const other = seen.get(d);
      if (other !== undefined && !(other === "star" && name === "starFilled")) {
        duplicates.push(`${other} = ${name}`);
      }
      seen.set(d, name);
    }
    expect(duplicates).toEqual([]);
  });

  it("keeps every lit facet and filled part inside its icon, every 12 px drawing on the grid", () => {
    const stray = ICON_NAMES.flatMap((name) => {
      const facet = iconFacet(name);
      if (facet === undefined) return [];
      const outer = box(iconPath(name));
      const b = box(facet);
      const inside =
        b.x0 >= outer.x0 - 0.01 &&
        b.x1 <= outer.x1 + 0.01 &&
        b.y0 >= outer.y0 - 0.01 &&
        b.y1 <= outer.y1 + 0.01;
      return inside ? [] : [name];
    });
    expect(stray).toEqual([]);
    const strayFills = ICON_NAMES.flatMap((name) =>
      iconFills(name).flatMap((fill) => {
        const b = box(fill);
        return b.x0 >= 2.9 && b.y0 >= 2.9 && b.x1 <= 21.1 && b.y1 <= 21.1 ? [] : [name];
      }),
    );
    expect(strayFills).toEqual([]);
    const offGrid = ICON_NAMES.flatMap((name) => {
      const small = iconSmallPath(name);
      if (small === undefined) return [];
      const b = box(small);
      const ok =
        b.x0 >= 2.9 &&
        b.y0 >= 2.9 &&
        b.x1 <= 21.1 &&
        b.y1 <= 21.1 &&
        Math.abs(b.cx - 12) <= 0.6 &&
        Math.abs(b.cy - 12) <= 0.6;
      return ok ? [] : [name];
    });
    expect(offGrid).toEqual([]);
  });

  it("keeps the facets for icons with a surface; controls stay pure line", () => {
    const controls: IconName[] = ["plus", "minus", "close", "check", "chevron", "back", "more"];
    expect(controls.filter((name) => iconFacet(name) !== undefined)).toEqual([]);
  });

  it("draws every icon as reviewed on board Icons.dc.html (outline, facet and 12 px drawing)", () => {
    const drawings = Object.fromEntries(
      ICON_NAMES.map((name) => [
        name,
        {
          path: iconPath(name),
          facet: iconFacet(name) ?? null,
          fills: iconFills(name),
          small: iconSmallPath(name) ?? null,
        },
      ]),
    );
    expect(drawings).toMatchSnapshot();
  });

  it("renders one style: current color, round caps, mitered joins, hidden from screen readers", () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg?.getAttribute("stroke")).toBe("currentColor");
      expect(svg?.getAttribute("stroke-linecap")).toBe("round");
      expect(svg?.getAttribute("stroke-linejoin")).toBe("miter");
      // Sharp angles (star points, arrow tips) turn into bevels instead of spikes.
      expect(svg?.getAttribute("stroke-miterlimit")).toBe("2");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("focusable")).toBe("false");
      for (const path of container.querySelectorAll("path")) {
        expect(path.getAttribute("fill") ?? "none").toMatch(/^(none|currentColor)$/);
      }
      const facets = container.querySelectorAll(".icon__facet");
      expect(facets.length).toBe(iconFacet(name) === undefined ? 0 : 1);
      // The tint without the stylesheet; components.css sets it from --icon-facet-opacity.
      for (const facet of facets) expect(facet.getAttribute("fill-opacity")).toBe("0.2");
      unmount();
    }
  });
});

describe("icons in motion", () => {
  it("moves whole pieces of the drawing: subpaths of the outline, the facet or filled parts", () => {
    const stray = ICON_NAMES.flatMap((name) =>
      (iconMotion(name)?.parts ?? []).flat().flatMap((piece) => {
        if (piece === FACET) return iconFacet(name) === undefined ? [`${name}: no facet`] : [];
        const whole = subpaths(iconPath(name)).includes(piece) || iconFills(name).includes(piece);
        return whole ? [] : [`${name}: ${piece}`];
      }),
    );
    expect(stray).toEqual([]);
  });

  it("gives the board's motions to its twelve icons, the star and every navigation entry", () => {
    const motions = Object.fromEntries(
      ICON_NAMES.flatMap((name) => {
        const motion = iconMotion(name)?.motion;
        return motion === undefined ? [] : [[name, motion]];
      }),
    );
    expect(motions).toEqual({
      dashboards: "lift",
      explore: "turn",
      bell: "ring",
      settings: "slide",
      search: "glint",
      user: "nod",
      network: "tilt",
      dataSources: "drop",
      plus: "quarter",
      close: "quarter",
      refresh: "spin",
      check: "draw",
      starFilled: "fill",
      home: "lift",
      file: "lift",
      shieldCheck: "lift",
      members: "nod",
      ask: "tilt",
    });
  });

  it("draws a moving icon as its still picture: the same outline, facet and fills", () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      const body = svg?.querySelector(":scope > g.icon__body");
      expect(body, name).not.toBeNull();
      const outline = [...container.querySelectorAll("path")]
        .filter((path) => !path.classList.contains("icon__facet"))
        .filter((path) => path.getAttribute("fill") !== "currentColor")
        .map((path) => path.getAttribute("d") ?? "");
      expect(subpaths(outline.join("")).sort(), name).toEqual(subpaths(iconPath(name)).sort());
      const fills = [...container.querySelectorAll('path[fill="currentColor"]')]
        .filter((path) => !path.classList.contains("icon__facet"))
        .map((path) => path.getAttribute("d"));
      expect(fills.sort(), name).toEqual([...iconFills(name)].sort());
      const motion = iconMotion(name);
      expect(svg?.getAttribute("data-motion") ?? undefined, name).toBe(motion?.motion);
      expect(container.querySelectorAll(".icon__part").length, name).toBe(
        motion === undefined ? 0 : (motion.parts?.length ?? 1),
      );
      unmount();
    }
  });

  it("plays only on request and only where there is a motion; a 12 px drawing keeps its own", () => {
    const { container, rerender } = render(<Icon name="check" />);
    const svg = () => container.querySelector("svg");
    expect(svg()?.hasAttribute("data-play")).toBe(false);
    // The check draws along its length.
    expect(container.querySelector("path")?.getAttribute("pathLength")).toBe("1");
    rerender(<Icon name="check" play />);
    expect(svg()?.hasAttribute("data-play")).toBe(true);
    rerender(<Icon name="copy" play />);
    expect(svg()?.hasAttribute("data-play")).toBe(false);
    rerender(<Icon name="close" size="small" />);
    expect(svg()?.getAttribute("data-motion")).toBe("quarter");
    expect(container.querySelector(".icon__part path")?.getAttribute("d")).toBe(
      iconSmallPath("close"),
    );
  });

  it("drops `play` when the motion has ended, so a re-render never replays it", () => {
    const { container, rerender } = render(<Icon name="check" play />);
    const svg = () => container.querySelector("svg");
    expect(svg()?.hasAttribute("data-play")).toBe(true);
    fireEvent.animationEnd(container.querySelector(".icon__part") as Element);
    expect(svg()?.hasAttribute("data-play")).toBe(false);
    rerender(<Icon name="check" play className="x" />);
    expect(svg()?.hasAttribute("data-play")).toBe(false);
    // Asked again (off, then on): it plays once more.
    rerender(<Icon name="check" />);
    rerender(<Icon name="check" play />);
    expect(svg()?.hasAttribute("data-play")).toBe(true);
  });

  it("waits for every moving part before it drops `play`", () => {
    const { container } = render(<Icon name="network" play />);
    const svg = () => container.querySelector("svg");
    const parts = [...container.querySelectorAll(".icon__part")];
    expect(parts).toHaveLength(3);
    fireEvent.animationEnd(parts[0] as Element);
    fireEvent.animationEnd(parts[1] as Element);
    expect(svg()?.hasAttribute("data-play")).toBe(true);
    fireEvent.animationEnd(parts[2] as Element);
    expect(svg()?.hasAttribute("data-play")).toBe(false);
  });
});

const SRC = resolve(import.meta.dirname, "..");

function sources(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return sources(path, pattern);
    return pattern.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const read = (path: string) => ({
  path: relative(SRC, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
});

/** The UI code (components and plain modules), without tests. */
const code = sources(SRC, /\.tsx?$/).map(read);
const files = code.filter(({ path }) => path.endsWith(".tsx"));
/** The texts of every language. */
const catalogs = sources(resolve(SRC, "i18n"), /\.json$/).map(read);

// Triangles, arrows, check marks, crosses, stars, the braille drag dots, the ellipsis menus.
const GLYPHS =
  /[\u{25be}\u{25b8}\u{25b4}\u{25b2}\u{25bc}\u{25c2}\u{25c0}\u{25b6}\u{283f}\u{2630}\u{22ee}\u{22ef}\u{2713}\u{2714}\u{2715}\u{2716}\u{2717}\u{2605}\u{2606}\u{2191}\u{2193}]/u;

/**
 * Lines of code that may hold such a character, each marked with a comment `glyph-ok: <why>` on
 * the line or the one before (keyboard keys in the shortcut help, for example).
 */
const MARKER = /glyph-ok:/;

/** Texts that may hold one: they name keys to press, not icons. */
const CATALOG_ALLOWED: ReadonlySet<string> = new Set<string>();

/** The end of the JSX tag that starts at `start`: the first `>` outside braces. */
function tagEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return text.length;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

describe("icons in the UI", () => {
  it("draws icons with the icon set or as named pictures, never as text characters", () => {
    const found = code.flatMap(({ path, text }) => {
      const lines = text.split("\n");
      return lines.flatMap((line, index) =>
        GLYPHS.test(line) && !MARKER.test(line) && !MARKER.test(lines[index - 1] ?? "")
          ? [`${path}:${index + 1}`]
          : [],
      );
    });
    expect(found).toEqual([]);
  });

  it("keeps such characters out of the texts too, except where they name keys", () => {
    const found = catalogs.flatMap(({ path, text }) =>
      Object.entries(JSON.parse(text) as Record<string, string>).flatMap(([key, value]) =>
        GLYPHS.test(value) && !CATALOG_ALLOWED.has(key) ? [`${path} ${key}`] : [],
      ),
    );
    expect(found).toEqual([]);
  });

  it("hides decorative SVG drawings from screen readers, or names the picture", () => {
    const unnamed = files.flatMap(({ path, text }) =>
      [...text.matchAll(/<svg\b/g)].flatMap((match) => {
        const tag = text.slice(match.index, tagEnd(text, match.index) + 1);
        const ok =
          /aria-hidden="true"/.test(tag) ||
          (/role="img"/.test(tag) && /aria-label(ledby)?=/.test(tag));
        return ok ? [] : [`${path}:${lineOf(text, match.index)}`];
      }),
    );
    expect(unnamed).toEqual([]);
  });

  it("gives every button that shows only an icon an accessible name", () => {
    const nameless = files.flatMap(({ path, text }) =>
      [...text.matchAll(/<button\b/g)].flatMap((match) => {
        const openEnd = tagEnd(text, match.index);
        const tag = text.slice(match.index, openEnd + 1);
        const close = text.indexOf("</button>", openEnd);
        if (tag.endsWith("/>") || close === -1) return [];
        const content = text
          .slice(openEnd + 1, close)
          .replace(/<Icon\b[^>]*\/>/g, "")
          .replace(/\{[^{}]*\?\s*\(?\s*\)?\s*:\s*null\s*\}/g, "")
          .trim();
        const inner = text.slice(openEnd + 1, close).trim();
        // An icon passed in a variable (`{icon}`, `{statusIcon}`) counts as an icon too.
        const iconVariable = /^\{\s*\w*icon\w*\s*\}$/i.test(inner);
        const iconOnly = (/<Icon\b/.test(inner) && content === "") || iconVariable;
        const named = /aria-label(ledby)?=/.test(tag);
        return iconOnly && !named ? [`${path}:${lineOf(text, match.index)}`] : [];
      }),
    );
    expect(nameless).toEqual([]);
  });
});
