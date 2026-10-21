import { type RefObject, useLayoutEffect } from "react";

/**
 * Sets CSS custom properties on an element, for geometry that comes from data (a panel's place in
 * the dashboard grid, the height of a table's virtual rows). Stylesheets read them with var(), so
 * every look stays in CSS and the code passes numbers only. Set through the CSSOM, which the
 * content security policy allows, instead of a style attribute.
 */
export function useStyleVars(
  ref: RefObject<HTMLElement | SVGElement | null>,
  vars: Record<string, string | number>,
): void {
  const entries = Object.entries(vars);
  const signature = entries.map(([name, value]) => `${name}:${value}`).join(";");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for `vars`
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    for (const [name, value] of entries) {
      element.style.setProperty(name, String(value));
    }
  }, [ref, signature]);
}
