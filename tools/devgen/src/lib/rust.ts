import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { run, slash } from "./repo.ts";

/**
 * Reading and editing the server's declarations that the scaffolds touch: permissions and roles
 * (`authz.rs`), error codes (`error.rs`), the reasons check's namespaces (`datasources/detail.rs`)
 * and the generated TypeScript unions (`ui/src/api/generated/shapes.ts`).
 */

export const AUTHZ = "server/src/authz.rs";
export const ERROR = "server/src/error.rs";
export const DETAIL = "server/src/datasources/detail.rs";
export const SHAPES = "ui/src/api/generated/shapes.ts";
export const SETTINGS = "server/src/settings.rs";
export const ROUTES_MOD = "server/src/routes/mod.rs";

/** `"dashboards:read"` -> `DashboardsRead`, from the `permissions!` table. */
export function permissions(authz: string): Map<string, string> {
  const block = /permissions!\s*\{([\s\S]*?)\n\}/.exec(authz)?.[1] ?? "";
  const map = new Map<string, string>();
  for (const match of block.matchAll(/(\w+)\s*=>\s*"([\w:]+)"/g)) {
    map.set(match[2] ?? "", match[1] ?? "");
  }
  return map;
}

/** The built-in roles' permissions (variant names), weakest first. */
export function rolePermissions(authz: string): [string, Set<string>][] {
  const list = (name: string) =>
    new Set(
      [
        ...(new RegExp(`let ${name} = \\[([\\s\\S]*?)\\];`).exec(authz)?.[1] ?? "").matchAll(
          /^\s*([A-Z]\w+),?/gm,
        ),
      ].map((m) => m[1] ?? ""),
    );
  const viewer = list("viewer");
  const editor = new Set([...viewer, ...list("editor_extra")]);
  const admin = new Set([...editor, ...list("admin_extra")]);
  return [
    ["viewer", viewer],
    ["editor", editor],
    ["admin", admin],
  ];
}

export function errorCodes(error: string): string[] {
  const block = /pub const ERROR_CODES: &\[&str\] = &\[([\s\S]*?)\];/.exec(error)?.[1] ?? "";
  return [...block.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
}

/** ERROR_CODES with `code` added before `internal`, which stays last. */
export function addErrorCode(error: string, code: string): string {
  if (errorCodes(error).includes(code)) {
    return error;
  }
  return error.replace(
    /(pub const ERROR_CODES: &\[&str\] = &\[[\s\S]*?)(\n\s*"internal",\n\];)/,
    `$1\n    "${code}",$2`,
  );
}

export function namespaces(detail: string): string[] {
  const block = /const NAMESPACES: &\[&str\] = &\[([\s\S]*?)\];/.exec(detail)?.[1] ?? "";
  return [...block.matchAll(/^\s*"(\w+)",/gm)].map((m) => m[1] ?? "");
}

/** Adds a namespace to the reasons check, with a comment that names its docs. */
export function addNamespace(detail: string, namespace: string, comment: string): string {
  if (namespaces(detail).includes(namespace)) {
    return detail;
  }
  return detail.replace(
    /(const NAMESPACES: &\[&str\] = &\[[\s\S]*?)(\n\s*\];)/,
    `$1\n        // ${comment}\n        "${namespace}",$2`,
  );
}

export function notReasons(detail: string): string[] {
  const block = /const NOT_REASONS: &\[&str\] = &\[([\s\S]*?)\];/.exec(detail)?.[1] ?? "";
  return [...block.matchAll(/^\s*"([\w.]+)",/gm)].map((m) => m[1] ?? "");
}

/** Lists a `ns.name` literal that is not a reason (a setting key), so the reasons check skips it. */
export function addNotReason(detail: string, literal: string, comment: string): string {
  if (notReasons(detail).includes(literal)) {
    return detail;
  }
  return detail.replace(
    /(const NOT_REASONS: &\[&str\] = &\[[\s\S]*?)(\n\s*\];)/,
    `$1\n        // ${comment}\n        "${literal}",$2`,
  );
}

/** The registry's keys in order, each once (as the generated SettingKey lists them). */
export function registryKeys(settings: string): string[] {
  const block =
    /pub const REGISTRY: &\[SettingDef\] = &\[([\s\S]*?)\n\];/.exec(settings)?.[1] ?? "";
  const keys: string[] = [];
  for (const match of block.matchAll(/key: "([\w.]+)"/g)) {
    const key = match[1] ?? "";
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/** The generated file with one string union rewritten, as the server's shapes test writes it. */
export function setUnion(shapes: string, name: string, values: readonly string[]): string {
  const pattern = new RegExp(`export type ${name} = [^;]+;`);
  if (!pattern.test(shapes)) {
    throw new Error(`${name} not found in ${SHAPES}`);
  }
  return shapes.replace(
    pattern,
    `export type ${name} = ${values.map((v) => `"${v}"`).join(" | ")};`,
  );
}

/** Runs rustfmt over files with the repository's settings; answers a warning when it cannot. */
export function formatRust(root: string, files: string[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const result = run(
    "rustfmt",
    ["--edition", "2024", "--config-path", join(root, "rustfmt.toml"), ...files],
    root,
  );
  return result.ok
    ? undefined
    : `rustfmt failed or is missing; run cargo fmt before committing: ${result.stderr.trim().split("\n")[0]}`;
}

/** Formats UI files with the UI's own Biome, when its packages are installed. */
export function formatUi(root: string, files: string[]): string | undefined {
  const biome = join(root, "ui", "node_modules", "@biomejs", "biome", "bin", "biome");
  if (files.length === 0) {
    return undefined;
  }
  if (!existsSync(biome)) {
    return "ui/node_modules is missing; run npm ci in ui and then npm run format there";
  }
  const relativeFiles = files.map((file) => slash(relative(join(root, "ui"), file)));
  const result = run(
    process.execPath,
    [biome, "format", "--write", ...relativeFiles],
    join(root, "ui"),
  );
  return result.ok ? undefined : `biome format failed: ${result.stderr.trim().split("\n")[0]}`;
}

export function pascal(snake: string): string {
  return snake
    .split(/[_-]/)
    .filter((part) => part !== "")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}
