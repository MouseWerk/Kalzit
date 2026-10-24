import { readPreference, writePreference } from "../lib/storage";
import {
  checkAccent,
  DENSITIES,
  type Density,
  FONT_SIZES,
  type FontSize,
  isAccentName,
  isHexColor,
} from "./contrast";

/**
 * The look an admin chose (settings `appearance.accent`, `appearance.density` and
 * `appearance.font_size`), applied through data attributes the design tokens read
 * (`styles/tokens.css`, "Appearance"). A custom accent color is the one value that is not a
 * token: it is set as the custom property `--accent-custom` through the CSSOM, which the CSP
 * allows, and the tokens derive every accent shade from it.
 */
export interface Look {
  accent: string;
  density: Density;
  fontSize: FontSize;
}

export const DEFAULT_LOOK: Look = { accent: "copper", density: "balanced", fontSize: 14 };

// public/theme-boot.js reads the same key before the first paint, so the look does not flash.
export const LOOK_STORAGE_KEY = "kalzit.look";

export function lookFrom(value: { accent?: unknown; density?: unknown; fontSize?: unknown }): Look {
  const accent =
    typeof value.accent === "string" && (isAccentName(value.accent) || isHexColor(value.accent))
      ? value.accent
      : DEFAULT_LOOK.accent;
  const density = DENSITIES.find((d) => d === value.density) ?? DEFAULT_LOOK.density;
  const fontSize = FONT_SIZES.find((s) => s === value.fontSize) ?? DEFAULT_LOOK.fontSize;
  return { accent, density, fontSize };
}

/** Sets the look on `element`: the document for the app, a container for a preview. */
export function applyLook(element: HTMLElement, look: Look): void {
  const custom = !isAccentName(look.accent);
  const check = custom ? checkAccent(look.accent) : null;
  if (check === null || !check.passes) {
    element.dataset.accent = custom ? "copper" : look.accent;
    element.style.removeProperty("--accent-custom");
    delete element.dataset.accentOn;
  } else {
    element.dataset.accent = "custom";
    element.style.setProperty("--accent-custom", look.accent);
    element.dataset.accentOn = check.darkLabel ? "dark" : "light";
  }
  element.dataset.density = look.density;
  element.dataset.fontSize = String(look.fontSize);
}

let current: Look = DEFAULT_LOOK;

/** Applies the look to the whole app and remembers it for the next page load. */
export function setLook(look: Look): void {
  current = look;
  applyLook(document.documentElement, look);
  writePreference(LOOK_STORAGE_KEY, JSON.stringify(look));
}

export function getLook(): Look {
  return current;
}

function storedLook(): Look {
  try {
    return lookFrom(
      JSON.parse(readPreference(LOOK_STORAGE_KEY) ?? "{}") as Record<string, unknown>,
    );
  } catch {
    return DEFAULT_LOOK;
  }
}

current = storedLook();
applyLook(document.documentElement, current);
