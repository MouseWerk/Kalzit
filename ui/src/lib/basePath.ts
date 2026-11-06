/**
 * The sub-path the server is reached under behind a reverse proxy (`server.base_path`, such as
 * `/kalzit`), or "" at the root. The server writes it into index.html as
 * `<meta name="kalzit-base-path">`; the dev server and tests have none.
 */

const VALID = /^(\/[A-Za-z0-9._~-]+)+$/;

let cached: string | undefined;

export function basePath(): string {
  if (cached === undefined) {
    const value =
      typeof document === "undefined"
        ? null
        : document.querySelector('meta[name="kalzit-base-path"]')?.getAttribute("content");
    const valid =
      value != null &&
      VALID.test(value) &&
      value.split("/").every((segment) => segment !== "." && segment !== "..");
    cached = valid ? value : "";
  }
  return cached;
}

/** A server path (`/api/...`, `/login`) with the sub-path in front; other URLs stay as they are. */
export function withBase(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") ? `${basePath()}${path}` : path;
}

/** A path of this page's address without the sub-path, as the app's routes see it. */
export function withoutBase(pathname: string): string {
  const base = basePath();
  if (base === "" || !(pathname === base || pathname.startsWith(`${base}/`))) {
    return pathname;
  }
  return pathname.slice(base.length) || "/";
}

/** For tests: forget the value read from the page. */
export function resetBasePath(): void {
  cached = undefined;
}
