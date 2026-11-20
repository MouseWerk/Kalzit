/**
 * A ref that sets CSS custom properties on its element, for geometry that comes from data (a
 * span's place on the time axis). Set through the CSSOM, which the content security policy
 * allows, instead of a style attribute; the stylesheet reads them with var().
 */
export function cssVars(vars: Record<string, string | number>) {
  return (element: HTMLElement | SVGElement | null) => {
    if (element === null) {
      return;
    }
    for (const [name, value] of Object.entries(vars)) {
      element.style.setProperty(name, String(value));
    }
  };
}
