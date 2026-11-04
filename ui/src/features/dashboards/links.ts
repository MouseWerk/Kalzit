import {
  optionValues,
  type VariableModel,
  type VariableValue,
  type VariableValues,
  valueList,
} from "./model";

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

/** Prefix of a variable's value in a dashboard's address: `?var-customer=42`. */
export const VARIABLE_PARAM = "var-";

/**
 * Variable values a dashboard address carries (`?var-region=eu&var-hosts=a&var-hosts=b`), as a
 * link from another dashboard sets them. Read from the raw query text, so a value stays the text
 * it was (`007`, `1e3`); a name given twice holds both values. Only names a variable can have.
 */
export function variablesFromSearch(search: string): VariableValues {
  const params = new URLSearchParams(search);
  const values: [string, string | string[]][] = [];
  for (const key of new Set(params.keys())) {
    const name = key.slice(VARIABLE_PARAM.length);
    if (!key.startsWith(VARIABLE_PARAM) || !/^[A-Za-z_]\w*$/.test(name)) {
      continue;
    }
    const all = params.getAll(key);
    values.push([name, all.length === 1 ? (all[0] ?? "") : all]);
  }
  // Built with `Object.fromEntries`, so a name like `__proto__` stays a plain entry.
  return Object.fromEntries(values);
}

/** A dashboard's search parameters without the `var-` ones, once the dashboard has taken them. */
export function withoutVariableParams<T extends object>(search: T): T {
  return Object.fromEntries(
    Object.entries(search).filter(([key]) => !key.startsWith(VARIABLE_PARAM)),
  ) as T;
}

/**
 * The values from an address that a dashboard's variables take: free text and query variables
 * any value, a fixed-values (`custom`) one only its options (the server refuses others), a
 * single-value variable only the first of several, a multi-value one all of them. Constants and
 * intervals keep their own; names the dashboard does not have are left out.
 */
export function fitAddressValues(
  variables: readonly VariableModel[],
  values: VariableValues,
): VariableValues {
  const fitted: [string, VariableValue][] = [];
  for (const variable of variables) {
    if (!Object.hasOwn(values, variable.name)) continue;
    if (variable.type !== "textbox" && variable.type !== "query" && variable.type !== "custom") {
      continue;
    }
    const allowed = variable.type === "custom" ? new Set(optionValues(variable)) : null;
    const list = valueList(values[variable.name]).filter((v) => allowed?.has(v) ?? true);
    const multi = variable.multi === true && variable.type !== "textbox";
    if (list.length === 0) continue;
    fitted.push([variable.name, multi ? list : (list[0] as string)]);
  }
  return Object.fromEntries(fitted);
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
