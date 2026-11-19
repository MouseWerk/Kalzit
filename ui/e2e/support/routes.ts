import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

export interface AppRoute {
  /** The variable the route is declared as, such as `membersRoute`. */
  name: string;
  /** The full path pattern as the router matches it, such as `/admin/teams/$teamId`. */
  pattern: string;
  /** Under the app shell, so it needs a session. */
  guarded: boolean;
  /** The route only sends people on to another address (an earlier address of a page). */
  redirectOnly: boolean;
  file: string;
}

/** Every file that declares routes: the base routes, the router and each feature's routes file. */
function routeFiles(): string[] {
  const files = [join(SRC, "app", "baseRoutes.tsx"), join(SRC, "app", "router.tsx")];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/^routes\.tsx?$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(join(SRC, "features"));
  return files;
}

const DECLARATION =
  /(?:export\s+)?const\s+(\w+)\s*=\s*create(?:Root)?Route(?:WithContext<[^>]*>\(\))?\(\{/g;

function joinPath(parent: string, path: string): string {
  const joined = `${parent.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  return joined.length > 1 ? joined.replace(/\/$/, "") : "/";
}

/**
 * The app's routes, read from the route declarations in the source (`createRoute` with its parent
 * and path), so a page added to the router shows up here without anyone listing it. Layout routes
 * without a path pass their parent's path on.
 */
export function appRoutes(): AppRoute[] {
  // Keyed by file and name: two features may call a route the same (`settingsRoute`).
  const declared = new Map<
    string,
    {
      name: string;
      parent: string | null;
      path: string | null;
      redirectOnly: boolean;
      file: string;
    }
  >();
  const byName = new Map<string, string>();
  for (const file of routeFiles()) {
    const text = readFileSync(file, "utf8");
    const starts = [...text.matchAll(DECLARATION)];
    starts.forEach((match, index) => {
      const body = text.slice(match.index, starts[index + 1]?.index ?? text.length);
      const name = match[1] ?? "";
      const parent = /getParentRoute:\s*\(\)\s*=>\s*(\w+)/.exec(body)?.[1] ?? null;
      const path = /\bpath:\s*"([^"]*)"/.exec(body)?.[1] ?? null;
      const redirectOnly = !/\bcomponent:/.test(body) && /redirect\w*\(/.test(body);
      const short = file.slice(SRC.length + 1).replaceAll("\\", "/");
      const key = `${short}#${name}`;
      declared.set(key, { name, parent, path, redirectOnly, file: short });
      // Routes other files build on are exported and named once.
      if (match[0].startsWith("export")) {
        byName.set(name, key);
      }
    });
  }
  const full = (key: string): { pattern: string; guarded: boolean } => {
    const route = declared.get(key);
    if (route === undefined || route.parent === null) {
      return { pattern: "/", guarded: false };
    }
    // The parent from the same file, else an exported one.
    const local = `${route.file}#${route.parent}`;
    const parent = full(declared.has(local) ? local : (byName.get(route.parent) ?? ""));
    return {
      pattern: route.path === null ? parent.pattern : joinPath(parent.pattern, route.path),
      guarded: parent.guarded || route.parent === "appRoute",
    };
  };
  const routes: AppRoute[] = [];
  for (const [key, route] of declared) {
    // Layout routes without a path of their own are no address.
    if (route.parent === null || route.path === null) {
      continue;
    }
    routes.push({
      name: route.name,
      ...full(key),
      redirectOnly: route.redirectOnly,
      file: route.file,
    });
  }
  return routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** Whether a visited path is an instance of a route pattern (`$param` matches one segment). */
export function matchesRoute(pattern: string, path: string): boolean {
  const clean = (path.split(/[?#]/)[0] ?? "").replace(/(.)\/$/, "$1");
  const expected = pattern.split("/");
  const actual = clean.split("/");
  return (
    expected.length === actual.length &&
    expected.every((part, i) => (part.startsWith("$") ? actual[i] !== "" : part === actual[i]))
  );
}
