import data from "./lucide.json";

/**
 * The icons a style rule can put on a node: a subset of Lucide (https://lucide.dev, ISC; the
 * icons derived from Feather MIT, see LICENSE next to this file), about 300 of them, each as one
 * stroked path on a 24 by 24 grid. `scripts/graph-icons.mjs` writes the data from the names in
 * names.txt. The set stands in until the product has icons of its own.
 */

export interface StyleIconData {
  /** SVG path data on a 24 by 24 grid, stroked two units wide with round caps and joins. */
  d: string;
  /** Words the picker's search finds the icon by, besides its name. */
  tags: readonly string[];
}

/** The grid the paths are drawn on. */
export const ICON_GRID = 24;
export const ICON_STROKE = 2;

export const ICONS: Readonly<Record<string, StyleIconData>> = data.icons;
export const ICON_NAMES: readonly string[] = Object.keys(data.icons);
/** Where the set comes from, with its version. */
export const ICON_SOURCE: string = data.source;

/** The icon of a name; undefined for a name the set does not have (a rule from a later set). */
export function iconOf(name: string): StyleIconData | undefined {
  return Object.hasOwn(ICONS, name) ? ICONS[name] : undefined;
}

/** The icons whose name or tags contain every word of `query`, in the set's order. */
export function searchIcons(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...ICON_NAMES];
  return ICON_NAMES.filter((name) => {
    const hay = `${name.replaceAll("-", " ")} ${(ICONS[name]?.tags ?? []).join(" ")}`;
    return words.every((word) => hay.includes(word));
  });
}
