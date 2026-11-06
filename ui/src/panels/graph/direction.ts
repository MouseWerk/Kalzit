import { useState } from "react";
import {
  type ElkDirection,
  type ElkSettings,
  elkSettings,
  type GraphPanelOptions,
} from "./options";

/**
 * The hierarchy's direction, chosen per view in the panel's tools; it starts where the panel's
 * options put it, and a new direction in the options (the panel editor) replaces the chosen one.
 */
export function useViewDirection(
  fromOptions: ElkDirection,
): [ElkDirection, (direction: ElkDirection) => void] {
  const [direction, setDirection] = useState(fromOptions);
  const [seen, setSeen] = useState(fromOptions);
  if (seen !== fromOptions) {
    setSeen(fromOptions);
    setDirection(fromOptions);
  }
  return [direction, setDirection];
}

/**
 * ELK's settings for a hierarchy shown in `direction`: the panel's own when it uses ELK, else
 * ELK's defaults for any direction but down, since Kalzit's own layers only point down. Null
 * keeps Kalzit's layout.
 */
export function hierarchyElk(
  options: GraphPanelOptions,
  direction: ElkDirection,
): ElkSettings | null {
  if (options.hierarchyLayout !== "elk" && direction === "down") return null;
  return { ...(elkSettings({ ...options, hierarchyLayout: "elk" }) as ElkSettings), direction };
}
