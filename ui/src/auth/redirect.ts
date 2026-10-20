// Any absolute URL resolves against this placeholder origin; if the origin changes, the value
// pointed somewhere else and is rejected. ".invalid" can never be a real host (RFC 2606).
const BASE = "http://kalzit.invalid";

const AUTH_PATHS = new Set(["/login", "/setup"]);

/**
 * Returns a same-origin path to go back to after signing in, or undefined. Rejects absolute and
 * protocol-relative URLs ("//evil.example"), backslash tricks and the auth pages themselves, so
 * the redirect parameter can never become an open redirect or a loop.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return undefined;
  }
  // Browsers treat "\" like "/" in URLs, and control characters are stripped while parsing.
  if (value.includes("\\") || /\p{Cc}/u.test(value)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== BASE || AUTH_PATHS.has(url.pathname)) {
    return undefined;
  }
  // Dot segments collapse while parsing ("/..//evil.example" becomes "//evil.example"), so the
  // normalized result is checked again: a leading "//" would leave the site when navigated to.
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  if (normalized.startsWith("//") || normalized.includes("\\")) {
    return undefined;
  }
  return normalized;
}
