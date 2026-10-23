import { type VariableValues, valueList } from "./model";

/**
 * Link addresses of dashboards and panels. The server stores only addresses that start with
 * `http://`, `https://`, `mailto:` or `/` (dashboards/model.rs, `check_url`); variables are filled
 * in here, and the result is checked again, so a variable can never turn a link into script.
 */

const SCHEMES = ["http:", "https:", "mailto:"];

/** The same rule as the server: an allowed scheme written out, or a path on this server. */
export function isAllowedUrl(url: string): boolean {
  const control = [...url].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  if (url !== url.trim() || url === "" || control) {
    return false;
  }
  if (url.startsWith("/")) {
    return !url.startsWith("//") && !url.startsWith("/\\");
  }
  const colon = url.indexOf(":");
  if (colon < 0) {
    return false;
  }
  const scheme = url.slice(0, colon + 1).toLowerCase();
  if (!SCHEMES.includes(scheme)) {
    return false;
  }
  return scheme === "mailto:" || url.slice(colon + 1).startsWith("//");
}

/**
 * Fills `${name}` and `$name` with the variable's value, URL-encoded (several values joined by
 * commas). `extra` adds values for this link only, such as `__value` for a data link.
 */
export function fillVariables(
  url: string,
  values: VariableValues,
  extra: Record<string, string> = {},
): string {
  const all: VariableValues = { ...values, ...extra };
  return url.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (match, braced, bare) => {
    const name = (braced ?? bare) as string;
    if (!(name in all)) {
      return match;
    }
    return valueList(all[name])
      .map((v) => encodeURIComponent(v))
      .join(",");
  });
}

/** The address to open, or null when the filled-in link is not allowed. */
export function linkHref(
  url: string,
  values: VariableValues,
  extra?: Record<string, string>,
): string | null {
  const filled = fillVariables(url, values, extra);
  return isAllowedUrl(filled) ? filled : null;
}
