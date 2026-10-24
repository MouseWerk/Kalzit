import { isRecord } from "../../../api/client";

/**
 * The query form of HTTP JSON sources (docs/api/datasources.md, "HTTP JSON"): a path below the
 * source's URL, query parameters and where the documents are in the answer, all optional. `{}`
 * requests the source's URL as it is. Only GET is sent and no header comes from the query.
 */
export interface HttpQuery {
  path?: string;
  params?: Record<string, ParamValue>;
  documentsPath?: string;
}

export type ParamScalar = string | number | boolean;
/** A list repeats the parameter (`land=AT&land=CH`). */
export type ParamValue = ParamScalar | ParamScalar[];

export const HTTP_QUERY_KEYS = ["path", "params", "documentsPath"] as const;

const isScalar = (value: unknown): value is ParamScalar =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

/** A value the server takes for a parameter: a text, number, boolean or a list of them. */
export function isParamValue(value: unknown): value is ParamValue {
  return isScalar(value) || (Array.isArray(value) && value.every(isScalar));
}

/** The stored parameters as written, valid or not, in a map (so no name reaches a prototype). */
export function storedParams(query: unknown): Map<string, unknown> {
  const params = isRecord(query) && isRecord(query.params) ? query.params : {};
  return new Map(Object.entries(params));
}

/** Parameters as an object without a prototype, so `__proto__` is a name like any other. */
export function paramObject(entries: Iterable<[string, ParamValue]>): Record<string, ParamValue> {
  const params = Object.create(null) as Record<string, ParamValue>;
  for (const [name, value] of entries) {
    params[name] = value;
  }
  return params;
}

/** The query as the editor reads it; `httpQueryProblems` names what the server would refuse. */
export function parseHttpQuery(query: unknown): HttpQuery {
  const value = isRecord(query) ? query : {};
  const parsed: HttpQuery = {};
  if (typeof value.path === "string" && value.path !== "") {
    parsed.path = value.path;
  }
  const valid = [...storedParams(query)].filter((entry): entry is [string, ParamValue] =>
    isParamValue(entry[1]),
  );
  if (valid.length > 0) {
    parsed.params = paramObject(valid);
  }
  if (typeof value.documentsPath === "string" && value.documentsPath !== "") {
    parsed.documentsPath = value.documentsPath;
  }
  return parsed;
}

/**
 * The fields of a stored query the server would refuse: unknown ones, ones of the wrong type, and
 * parameters whose value is not a text, number, boolean or list of them (`params.<name>`).
 */
export function httpQueryProblems(query: unknown): string[] {
  if (!isRecord(query)) {
    return ["query"];
  }
  const problems = Object.keys(query).filter(
    (key) => !(HTTP_QUERY_KEYS as readonly string[]).includes(key),
  );
  for (const key of ["path", "documentsPath"]) {
    if (query[key] !== undefined && query[key] !== null && typeof query[key] !== "string") {
      problems.push(key);
    }
  }
  if (query.params !== undefined && !isRecord(query.params)) {
    problems.push("params");
  }
  for (const [name, value] of storedParams(query)) {
    if (!isParamValue(value)) {
      problems.push(`params.${name}`);
    }
  }
  return problems;
}

/** Whether a stored query has exactly the HTTP JSON form, so it can run as it is. */
export function isHttpQuery(query: unknown): boolean {
  return httpQueryProblems(query).length === 0;
}
/**
 * The server's path rule (`join_path`): relative, below the source's URL, without query or
 * fragment, without `.` segments or segments starting with `..`, backslashes, control characters,
 * a scheme, or percent-encoded dots, slashes, backslashes and percent signs.
 */
export function pathProblem(path: string): boolean {
  if (path === "") {
    return false;
  }
  const lower = path.toLowerCase();
  return (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    (path.split("/")[0] ?? "").includes(":") ||
    ["%2e", "%2f", "%5c", "%25"].some((encoded) => lower.includes(encoded)) ||
    path.split("/").some((segment) => segment === "." || segment.startsWith("..")) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
    /[\u0000-\u001f\u007f-\u009f]/.test(path)
  );
}

/** `$name` or `${name}` as the whole value: the server puts the variable's value there. */
export function variableName(text: string): string | null {
  const match = /^\$(?:\{(\w+)\}|(\w+))$/.exec(text);
  return match === null ? null : (match[1] ?? match[2] ?? null);
}

/**
 * The URL the server requests, for the preview: the path below the source's URL (which keeps its
 * own query) and the parameters after it. Variables stay as written. Undefined when the URL is
 * not known or does not parse.
 */
export function requestUrl(base: string | undefined, query: HttpQuery): string | undefined {
  if (base === undefined || base.trim() === "") {
    return undefined;
  }
  let url: URL;
  try {
    const parsed = new URL(base.trim());
    const dir = new URL(parsed.href);
    if (!dir.pathname.endsWith("/")) {
      dir.pathname = `${dir.pathname}/`;
    }
    url = query.path === undefined ? parsed : new URL(query.path, dir);
    url.search = parsed.search;
  } catch {
    return undefined;
  }
  for (const [name, value] of Object.entries(query.params ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(item));
    }
  }
  // Variables read better as written than percent-encoded.
  return url.href.replace(/%24(%7B)?(\w+)(%7D)?/g, (_, open, name, close) =>
    open !== undefined && close !== undefined ? `\${${name}}` : `$${name}`,
  );
}

/** The query in one line, for summaries: the path and the parameters. */
export function httpQueryText(query: HttpQuery): string {
  const params = Object.entries(query.params ?? {})
    .flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map((item) => `${name}=${String(item)}`),
    )
    .join("&");
  return [query.path ?? "", params === "" ? "" : `?${params}`].join("");
}
