/**
 * The CORS rules as the server applies them (server/src/cors.rs), for the checks the page makes
 * before it sends a value and for "Check an origin", which asks nothing of the server: an entry is
 * `scheme://host[:port]` without a path, `https://*.example.com` stands for every subdomain, a
 * bare `*` is refused, and `http` is for localhost only.
 */

export const CORS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface CorsSettings {
  enabled: boolean;
  origins: readonly string[];
  methods: readonly string[];
  headers: readonly string[];
  credentials: boolean;
  maxAgeSecs: number;
}

interface Origin {
  scheme: string;
  host: string;
  port: number;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** `scheme://host[:port]` exactly, with the scheme's default port filled in. */
function exactOrigin(text: string): Origin | null {
  if (text.includes("*") || /[\s\p{Cc}]/u.test(text)) return null;
  const at = text.indexOf("://");
  if (at < 0) return null;
  const scheme = text.slice(0, at).toLowerCase();
  const rest = text.slice(at + 3);
  if ((scheme !== "http" && scheme !== "https") || rest === "" || /[/?#@]/.test(rest)) return null;
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(rest);
  if (match === null) return null;
  const port = match[2] === undefined ? (scheme === "https" ? 443 : 80) : Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { scheme, host: (match[1] ?? "").toLowerCase(), port };
}

type Allowed = { exact: Origin } | { subdomains: Origin; suffix: string };

function allowedOrigin(text: string): Allowed | null {
  const star = text.indexOf("://*.");
  if (star >= 0) {
    const scheme = text.slice(0, star);
    const rest = text.slice(star + 5);
    const domain = rest.split(":")[0] ?? "";
    const labels = domain.split(".").filter((label) => label !== "").length;
    if (domain.includes("*") || labels < 2 || scheme !== "https") return null;
    const origin = exactOrigin(`${scheme}://x.${rest}`);
    return origin === null ? null : { subdomains: origin, suffix: origin.host.slice(1) };
  }
  const origin = exactOrigin(text);
  if (origin === null) return null;
  return origin.scheme === "https" || LOCAL_HOSTS.includes(origin.host) ? { exact: origin } : null;
}

export type OriginProblem =
  | { reason: "star" }
  | { reason: "path"; origin: string }
  | { reason: "http"; origin: string }
  | { reason: "invalid" };

/** Why an entry is refused, with the entry it probably meant; null for one the server takes. */
export function originProblem(text: string): OriginProblem | null {
  const entry = text.trim();
  if (allowedOrigin(entry) !== null) return null;
  if (entry === "*" || /^https?:\/\/\*(:\d+)?$/.test(entry)) return { reason: "star" };
  const withoutPath = /^(https?:\/\/[^/?#]+)[/?#]/.exec(entry)?.[1];
  if (withoutPath !== undefined && allowedOrigin(withoutPath) !== null) {
    return { reason: "path", origin: withoutPath };
  }
  if (entry.startsWith("http://")) {
    const secure = `https://${entry.slice(7)}`;
    if (allowedOrigin(secure) !== null) return { reason: "http", origin: secure };
  }
  return { reason: "invalid" };
}

/** A header name the server takes: an RFC 9110 token of at most 100 characters. */
export function validHeaderName(name: string): boolean {
  return /^[A-Za-z0-9!#$%&'+\-.^_`|~]{1,100}$/.test(name);
}

export type CorsAnswer =
  | { allowed: true; entry: string; headers: [string, string][] }
  | { allowed: false; reason: "off" | "origin" | "method" };

/** What a preflight from `origin` for `method` would be answered, by the settings given. */
export function checkOrigin(settings: CorsSettings, origin: string, method: string): CorsAnswer {
  const entries = settings.origins.filter((entry) => allowedOrigin(entry) !== null);
  if (!settings.enabled || entries.length === 0) return { allowed: false, reason: "off" };
  const asked = exactOrigin(origin.trim());
  const entry =
    asked === null
      ? undefined
      : entries.find((text) => {
          const allowed = allowedOrigin(text);
          if (allowed === null) return false;
          if ("exact" in allowed) {
            const { scheme, host, port } = allowed.exact;
            return scheme === asked.scheme && host === asked.host && port === asked.port;
          }
          // Never with the session cookie.
          return (
            !settings.credentials &&
            allowed.subdomains.scheme === asked.scheme &&
            allowed.subdomains.port === asked.port &&
            asked.host.endsWith(allowed.suffix) &&
            asked.host.length > allowed.suffix.length
          );
        });
  if (entry === undefined) return { allowed: false, reason: "origin" };
  const methods = settings.methods.map((name) => name.toUpperCase());
  if (!methods.includes(method.toUpperCase())) return { allowed: false, reason: "method" };
  const headers: [string, string][] = [
    ["Access-Control-Allow-Origin", origin.trim()],
    ["Access-Control-Allow-Methods", methods.join(", ")],
  ];
  if (settings.headers.length > 0) {
    headers.push([
      "Access-Control-Allow-Headers",
      settings.headers.map((name) => name.toLowerCase()).join(", "),
    ]);
  }
  if (settings.credentials) headers.push(["Access-Control-Allow-Credentials", "true"]);
  headers.push([
    "Access-Control-Max-Age",
    String(Math.min(Math.max(settings.maxAgeSecs, 0), 86400)),
  ]);
  headers.push(["Vary", "Origin"]);
  return { allowed: true, entry, headers };
}
