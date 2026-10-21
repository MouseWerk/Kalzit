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

/** Color vision deficiency simulations (Machado, Oliveira and Fernandes 2009, severity 1). */
const CVD_MATRICES = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
} as const;

export type Vision = keyof typeof CVD_MATRICES;
export const VISIONS = Object.keys(CVD_MATRICES) as Vision[];

function toOklab({ r, g, b }: Rgb): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * How far apart two colors look to someone with the given vision: OKLab distance times 100 after
 * simulating the deficiency. Around 2 is barely noticeable; chart series should be well apart.
 */
export function perceivedDistance(one: string, two: string, vision: Vision): number {
  const simulate = (color: string): [number, number, number] => {
    const { r, g, b } = oklchToLinearRgb(color);
    const [x, y, z] = CVD_MATRICES[vision].map((row) =>
      Math.min(1, Math.max(0, row[0] * r + row[1] * g + row[2] * b)),
    ) as [number, number, number];
    return toOklab({ r: x, g: y, b: z });
  };
  const [a, b] = [simulate(one), simulate(two)];
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
