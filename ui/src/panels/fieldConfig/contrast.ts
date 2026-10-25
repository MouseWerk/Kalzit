import { type Oklch, parseColor } from "../timeseries/canvasColor";

/**
 * WCAG contrast of a free colour against the panel surface, so the editor can say when a picked
 * colour would vanish. Colours arrive as hex or as computed CSS colours (`oklch()`, `rgb()`),
 * which `parseColor` reads; OKLCH goes back to linear sRGB with Björn Ottosson's matrices.
 */

/** Lines and marks need 3:1 against their surface (WCAG 1.4.11, non-text contrast). */
export const MIN_MARK_CONTRAST = 3;

function linearRgb({ l, c, h }: Oklch): [number, number, number] {
  const hue = (h * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ] as const;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clip(4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2]),
    clip(-1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2]),
    clip(-0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2]),
  ];
}

/** WCAG relative luminance of a colour, or null when it cannot be read. */
export function luminance(color: string): number | null {
  const parsed = parseColor(color);
  if (parsed === null) {
    return null;
  }
  const [r, g, b] = linearRgb(parsed);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two colours (1 to 21), or null when either cannot be read. */
export function contrastRatio(one: string, two: string): number | null {
  const a = luminance(one);
  const b = luminance(two);
  if (a === null || b === null) {
    return null;
  }
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}
