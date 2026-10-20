/**
 * WCAG contrast for OKLCH colors, used by the style tests to check every theme's token pairs.
 * Conversion: OKLCH -> OKLab -> linear sRGB (Björn Ottosson's matrices), clipped to the sRGB gamut.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?)?\s*\)$/;

/** Linear-light sRGB channels in [0, 1] for an `oklch(L% C H)` string. */
export function oklchToLinearRgb(color: string): Rgb {
  const match = OKLCH.exec(color.trim());
  if (match === null) {
    throw new Error(`not an oklch() color: ${color}`);
  }
  const lightness = Number(match[1]) / (match[2] === "%" ? 100 : 1);
  const chroma = Number(match[3]);
  const hue = (Number(match[4]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const clip = (value: number) => Math.min(1, Math.max(0, value));
  return {
    r: clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** WCAG 2 relative luminance from linear sRGB. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const one = relativeLuminance(oklchToLinearRgb(foreground));
  const two = relativeLuminance(oklchToLinearRgb(background));
  const [light, dark] = one > two ? [one, two] : [two, one];
  return (light + 0.05) / (dark + 0.05);
}
