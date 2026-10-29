import { getTheme } from "../../../theme/theme";

/**
 * Kalzit's design tokens as a panel plugin receives them (`theme` in `init` and the `theme`
 * message): colors resolved for the current scheme (a token that is `light-dark(...)` arrives as
 * the one color in force), the rest as declared. A panel draws only with these, so it looks like
 * the built-in panels in every theme.
 */

export const COLOR_TOKENS = [
  "--bg",
  "--bg-raised",
  "--bg-surface",
  "--bg-hover",
  "--bg-active",
  "--text",
  "--text-muted",
  "--border",
  "--border-strong",
  "--accent",
  "--accent-text",
  "--success-text",
  "--success-bg",
  "--warning-text",
  "--warning-bg",
  "--danger-text",
  "--danger-bg",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
  "--chart-8",
  "--chart-1-text",
  "--chart-2-text",
  "--chart-3-text",
  "--chart-4-text",
  "--chart-5-text",
  "--chart-6-text",
  "--chart-7-text",
  "--chart-8-text",
] as const;

export const OTHER_TOKENS = [
  "--font-sans",
  "--font-mono",
  "--font-size-2xs",
  "--font-size-xs",
  "--font-size-sm",
  "--font-size-md",
  "--font-size-lg",
  "--font-size-xl",
  "--font-size-2xl",
  "--font-size-display",
  "--font-weight-regular",
  "--font-weight-medium",
  "--font-weight-semibold",
  "--font-weight-bold",
  "--space-0",
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-8",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--border-width",
] as const;

export interface PanelTheme {
  scheme: "light" | "dark";
  tokens: Record<string, string>;
}

function scheme(): "light" | "dark" {
  const theme = getTheme();
  if (theme === "light" || theme === "dark") {
    return theme;
  }
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** The theme as the panel gets it, read from the page now. */
export function panelTheme(): PanelTheme {
  const root = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  // A probe resolves a color token the way the page draws it.
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);
  try {
    for (const name of COLOR_TOKENS) {
      probe.style.color = `var(${name})`;
      const resolved = getComputedStyle(probe).color;
      const value =
        resolved !== "" && !resolved.includes("var(")
          ? resolved
          : root.getPropertyValue(name).trim();
      if (value !== "") {
        tokens[name] = value;
      }
    }
  } finally {
    probe.remove();
  }
  for (const name of OTHER_TOKENS) {
    const value = root.getPropertyValue(name).trim();
    if (value !== "") {
      tokens[name] = value;
    }
  }
  return { scheme: scheme(), tokens };
}
