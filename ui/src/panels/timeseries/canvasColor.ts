/**
 * Colors for the canvas: the theme's colors arrive as computed CSS colors (`oklch(...)` or
 * `rgb(...)`, read through probe elements), and a fill needs them with an alpha or a shifted hue.
 * Everything is written back as `oklch(L C H / A)`, which canvases take. Free colors stored as
 * hex (`#rrggbb`, `#rrggbbaa`) read the same way.
 */

export interface Oklch {
  l: number;
  c: number;
  h: number;
  a: number;
}

function channel(text: string, percentOf = 1): number {
  return text.endsWith("%") ? (Number(text.slice(0, -1)) / 100) * percentOf : Number(text);
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB channels 0 to 1 to OKLCH (Björn Ottosson's OKLab matrices). */
export function rgbToOklch(r: number, g: number, b: number, a = 1): Oklch {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h, a };
}

/** A computed CSS color as OKLCH, or null when it is in a form this does not read. */
export function parseColor(color: string): Oklch | null {
  const text = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex !== null) {
    let digits = hex[1] as string;
    if (digits.length <= 4) {
      digits = [...digits].map((d) => d + d).join("");
    }
    const byte = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16) / 255;
    return rgbToOklch(byte(0), byte(2), byte(4), digits.length === 8 ? byte(6) : 1);
  }
  const fn = /^(rgba?|oklch)\(([^)]*)\)$/.exec(text);
  if (fn === null) {
    return null;
  }
  const [main = "", alphaText] = (fn[2] as string).split("/");
  const parts = main.split(/[\s,]+/).filter((p) => p !== "");
  let alpha = alphaText === undefined ? undefined : channel(alphaText.trim());
  if (fn[1] === "oklch") {
    if (parts.length !== 3) return null;
    const [l, c, h] = parts as [string, string, string];
    const result = {
      l: channel(l),
      c: channel(c, 0.4),
      h: h === "none" ? 0 : Number(h),
      a: alpha ?? 1,
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  }
  if (parts.length === 4 && alpha === undefined) {
    alpha = channel(parts.pop() as string);
  }
  if (parts.length !== 3) return null;
  const [r, g, b] = parts.map((p) => channel(p, 255) / 255) as [number, number, number];
  const result = rgbToOklch(r, g, b, alpha ?? 1);
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function write({ l, c, h, a }: Oklch): string {
  const round = (v: number, digits: number) => Number(v.toFixed(digits));
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(h, 2)} / ${round(a, 3)})`;
}

/** The color with its alpha multiplied by `alpha`; unreadable colors come back unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const parsed = parseColor(color);
  return parsed === null ? color : write({ ...parsed, a: parsed.a * alpha });
}

/** The color turned by `degrees` around the hue circle, for the hue gradient. */
export function shiftHue(color: string, degrees: number, alpha = 1): string {
  const parsed = parseColor(color);
  return parsed === null
    ? color
    : write({ ...parsed, h: (parsed.h + degrees + 360) % 360, a: parsed.a * alpha });
}
