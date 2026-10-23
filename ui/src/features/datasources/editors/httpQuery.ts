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

export type ParamValue = string | number | boolean;

export const HTTP_QUERY_KEYS = ["path", "params", "documentsPath"] as const;

export function parseHttpQuery(query: unknown): HttpQuery {
  const value = isRecord(query) ? query : {};
  const parsed: HttpQuery = {};
  if (typeof value.path === "string" && value.path !== "") {
    parsed.path = value.path;
  }
  if (isRecord(value.params)) {
    const params = Object.fromEntries(
      Object.entries(value.params).filter(
        (entry): entry is [string, ParamValue] =>
          typeof entry[1] === "string" ||
          typeof entry[1] === "boolean" ||
          (typeof entry[1] === "number" && Number.isFinite(entry[1])),
      ),
    );
    if (Object.keys(params).length > 0) {
      parsed.params = params;
    }
  }
  if (typeof value.documentsPath === "string" && value.documentsPath !== "") {
    parsed.documentsPath = value.documentsPath;
  }
  return parsed;
}

/** Whether a stored query has exactly the HTTP JSON form, so it can run as it is. */
export function isHttpQuery(query: unknown): boolean {
  return (
    isRecord(query) &&
    Object.keys(query).every((key) => (HTTP_QUERY_KEYS as readonly string[]).includes(key))
  );
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
    url.searchParams.append(name, String(value));
  }
  // Variables read better as written than percent-encoded.
  return url.href.replace(/%24(%7B)?(\w+)(%7D)?/g, (_, open, name, close) =>
    open !== undefined && close !== undefined ? `\${${name}}` : `$${name}`,
  );
}

/** The query in one line, for summaries: the path and the parameters. */
export function httpQueryText(query: HttpQuery): string {
  const params = Object.entries(query.params ?? {})
    .map(([name, value]) => `${name}=${String(value)}`)
    .join("&");
  return [query.path ?? "", params === "" ? "" : `?${params}`].join("");
}
