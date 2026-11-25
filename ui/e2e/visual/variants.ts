/**
 * The widths every screen is compared at, each in light and dark: a phone, a laptop, a large
 * monitor and an ultrawide one, and the laptop once more at twice the device scale. The name is
 * the Playwright project and the folder of its baselines.
 */
export interface Width {
  name: string;
  width: number;
  height: number;
  scale: 1 | 2;
}

export const WIDTHS: readonly Width[] = [
  { name: "360", width: 360, height: 780, scale: 1 },
  { name: "1280", width: 1280, height: 800, scale: 1 },
  { name: "2560", width: 2560, height: 1440, scale: 1 },
  { name: "3440", width: 3440, height: 1440, scale: 1 },
  { name: "1280@2x", width: 1280, height: 800, scale: 2 },
];

/**
 * The baselines are Linux pictures: fonts are drawn differently on Windows and macOS, so a run
 * elsewhere would differ everywhere. `KALZIT_VISUAL_ANY_SYSTEM=1` runs it anyway, to look at the
 * pictures.
 */
export const COMPARABLE =
  process.platform === "linux" || process.env.KALZIT_VISUAL_ANY_SYSTEM === "1";
export const NOT_COMPARABLE =
  "the baselines are made on Linux; fonts are drawn differently on other systems";

/**
 * How pictures are compared. Per pixel, `threshold` is the color distance (0 to 1, in YIQ) up to
 * which two pixels count as equal, stricter than Playwright's 0.2; beyond it a single pixel fails
 * (no share of pixels may differ). Two runs on one Linux machine give identical pictures; the
 * threshold is not raised to get a run green.
 */
export const COMPARISON = { threshold: 0.1, maxDiffPixels: 0 } as const;

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/**
 * The screens also taken at twice the device scale: one or two of each area, enough to see that
 * icons, hairlines and text stay sharp on a HiDPI screen. All screens at 2x would double the size
 * of the baselines for little more (a screen at 2x shows what it shows at 1x, only sharper).
 */
export const HIDPI_SCREENS: readonly string[] = [
  "home",
  "dashboards",
  "dashboard",
  "panel editor",
  "dashboard time picker",
  "share dialog",
  "explore result",
  "explore documents",
  "explore graph",
  "trace waterfall",
  "data sources",
  "data source",
  "alert rules",
  "alert rule",
  "contact points",
  "reports",
  "members",
  "roles",
  "administration",
  "plugins",
  "general settings",
  "account",
  "usage",
  "sign in",
  "local sign in",
  "public dashboard",
  "public snapshot",
  "public link unavailable",
  "page not found",
  "help: getting started",
];

/** The tests of a width project: at twice the scale only the screens above. */
export function screensAt(width: Width): RegExp {
  if (width.scale === 1) {
    return /.*/;
  }
  const names = HIDPI_SCREENS.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    `signed (in|out) (${names.join("|")})$|every (screen|baseline)|the setup steps$`,
  );
}

/**
 * The setup steps setup.visual.ts takes. The last one exists only once, after the setup is made,
 * so it has no picture at twice the device scale (that page cannot be made a second time).
 */
export const SETUP_STEPS = ["setup 1 code", "setup 2 account", "setup 3 organization"] as const;
export const SETUP_DONE = "setup 4 done";

/** A screen's name as a file name: `explore result` becomes `explore-result`. */
export const slug = (name: string) =>
  name
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

/** The baseline of a screen in a theme at a width: `<width>/<screen>--<theme>.png`. */
export const shotName = (width: Width, screen: string, theme: Theme): string[] => [
  width.name,
  `${slug(screen)}--${theme}.png`,
];
