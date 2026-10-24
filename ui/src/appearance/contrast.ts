/**
 * The contrast rules of a custom accent color, the same as the server's
 * (server/src/appearance.rs): at least 3:1 against the lightest light and the darkest dark
 * surface, and 4.5:1 for the label on it, white or near-black, whichever reads better. The server
 * refuses what fails; the settings page shows the numbers while the color is chosen.
 */

/** Accent colors defined for every scheme in the design tokens; copper is Kalzit's own. */
export const ACCENTS = [
  "copper",
  "blue",
  "teal",
  "green",
  "violet",
  "rose",
  "amber",
  "graphite",
] as const;
export type AccentName = (typeof ACCENTS)[number];

export const DENSITIES = ["compact", "balanced", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];

export const FONT_SIZES = [13, 14, 15, 16] as const;
export type FontSize = (typeof FONT_SIZES)[number];

export const START_PAGES = ["home", "dashboards", "explore"] as const;
export type StartPage = (typeof START_PAGES)[number];

/** `--bg-raised` light and `--bg-surface` dark as WCAG luminance (pinned by contrast.test.ts). */
export const LIGHT_SURFACE_LUMINANCE = 1;
export const DARK_SURFACE_LUMINANCE = 0.00481;
/** White, and `--on-accent` of the dark scheme. */
export const LIGHT_LABEL_LUMINANCE = 1;
export const DARK_LABEL_LUMINANCE = 0.00579;

export const MIN_UI_CONTRAST = 3;
export const MIN_TEXT_CONTRAST = 4.5;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

export function isAccentName(value: unknown): value is AccentName {
  return (ACCENTS as readonly unknown[]).includes(value);
}

function channel(hex: string, offset: number): number {
  const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance of `#rrggbb`, or null for anything else. */
export function hexLuminance(value: string): number | null {
  if (!isHexColor(value)) {
    return null;
  }
  return 0.2126 * channel(value, 1) + 0.7152 * channel(value, 3) + 0.0722 * channel(value, 5);
}

export function contrast(one: number, two: number): number {
  const [light, dark] = one > two ? [one, two] : [two, one];
  return (light + 0.05) / (dark + 0.05);
}

export interface AccentCheck {
  onLight: number;
  onDark: number;
  label: number;
  /** The near-black label reads better than white. */
  darkLabel: boolean;
  passes: boolean;
}

export function checkAccent(value: string): AccentCheck | null {
  const l = hexLuminance(value);
  if (l === null) {
    return null;
  }
  const light = contrast(l, LIGHT_LABEL_LUMINANCE);
  const dark = contrast(l, DARK_LABEL_LUMINANCE);
  const onLight = contrast(l, LIGHT_SURFACE_LUMINANCE);
  const onDark = contrast(l, DARK_SURFACE_LUMINANCE);
  const label = Math.max(light, dark);
  return {
    onLight,
    onDark,
    label,
    darkLabel: dark > light,
    passes: onLight >= MIN_UI_CONTRAST && onDark >= MIN_UI_CONTRAST && label >= MIN_TEXT_CONTRAST,
  };
}
