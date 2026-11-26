import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Sets CSS custom properties on an element, for geometry that comes from data (a panel's place in
 * the dashboard grid, the height of a table's virtual rows). Stylesheets read them with var(), so
 * every look stays in CSS and the code passes numbers only. Set through the CSSOM, which the
 * content security policy allows, instead of a style attribute.
 *
 * Written again when the values change or the ref points at another element (one that appears
 * after an empty state, say), so an element never misses values set before it was there.
 */
export function useStyleVars(
  ref: RefObject<HTMLElement | SVGElement | null>,
  vars: Record<string, string | number>,
): void {
  const entries = Object.entries(vars);
  const signature = entries.map(([name, value]) => `${name}:${value}`).join(";");
  const written = useRef<{ element: Element; signature: string } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      written.current = null;
      return;
    }
    if (written.current?.element === element && written.current.signature === signature) {
      return;
    }
    for (const [name, value] of entries) {
      element.style.setProperty(name, String(value));
    }
    written.current = { element, signature };
  });
}
