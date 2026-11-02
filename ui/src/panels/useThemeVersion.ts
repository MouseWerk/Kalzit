import { useEffect, useState } from "react";

/**
 * The media queries that change computed colors: the system's light and dark preference, and
 * forced colors (Windows high contrast), which swaps every color for a system color.
 */
const COLOR_QUERIES = ["(prefers-color-scheme: dark)", "(forced-colors: active)"];

/**
 * A number that changes with the theme: the data-theme attribute, the system's light and dark
 * preference or forced colors. What reads computed theme colours (a canvas, a contrast check)
 * reads them again.
 */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const media =
      typeof window.matchMedia === "function"
        ? COLOR_QUERIES.map((query) => window.matchMedia(query))
        : [];
    for (const list of media) {
      list.addEventListener("change", bump);
    }
    return () => {
      observer.disconnect();
      for (const list of media) {
        list.removeEventListener("change", bump);
      }
    };
  }, []);
  return version;
}
