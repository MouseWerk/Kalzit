import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { areaFor, insertEntry, LANGUAGES, messageProblems, readCatalogs } from "./i18n.ts";
import { readText, writeText } from "./repo.ts";
import {
  AUTHZ,
  addErrorCode,
  addNamespace,
  DETAIL,
  ERROR,
  errorCodes,
  formatRust,
  formatUi,
  namespaces,
  pascal,
  permissions,
  ROUTES_MOD,
  rolePermissions,
  SHAPES,
  setUnion,
} from "./rust.ts";

/**
 * A new API route in one step: the route table entry with its access, a handler that checks the
 * access again explicitly, the reason (and, if asked, a new error code) with its docs row and UI
 * texts, a docs/api section and an integration test for the allowed, forbidden and
 * unauthenticated cases. The output follows the conventions the server's tests enforce
 * (`routes::access_guard`, `datasources::detail` reasons check, the UI's reason and error tests).
 */

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof METHODS)[number];

export interface RouteRequest {
  /** Module under server/src/routes, created when missing (`widgets` -> routes/widgets.rs). */
  module: string;
  method: HttpMethod;
  /** Relative to /api, with axum parameters: `/orgs/{orgId}/widgets/{widgetId}`. */
  path: string;
  /** `Authenticated`, `ServerAdmin`, `OrgMember`, a permission such as `dashboards:write`, or `Public`. */
  access: string;
  /** snake_case name of the handler function. */
  handler: string;
  /** One English sentence: what the route does. */
  summary: string;
  /** File under docs/api for the route's section, created when missing. */
  docs: string;
  /** Heading of the reasons table and of a new docs file; defaults from the module name. */
  title?: string;
  /** A reason code (`widgets.name_missing`) the handler answers for an empty `name`. */
  reason?: string;
  reasonEn?: string;
  reasonDe?: string;
  /** Docs file whose Reasons section lists the reason; defaults to `docs`. */
  reasonDocs?: string;
  /** Error code of that refusal (default `validation`); a new one is registered everywhere. */
  errorCode?: string;
  /** HTTP status of a new error code. */
  errorStatus?: number;
  errorEn?: string;
  errorDe?: string;
  /** Formats the touched files with rustfmt and the UI's Biome (default true). */
  format?: boolean;
}

export interface ScaffoldResult {
  changed: string[];
  created: string[];
  next: string[];
  warnings: string[];
}

type Access =
  | { kind: "Public" }
  | { kind: "Authenticated" }
  | { kind: "ServerAdmin" }
  | { kind: "OrgMember" }
  | { kind: "Org"; permission: string; variant: string };

const STATUS: Record<number, string> = {
  400: "BAD_REQUEST",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "UNPROCESSABLE_ENTITY",
  429: "TOO_MANY_REQUESTS",
  503: "SERVICE_UNAVAILABLE",
};
/** Statuses of the existing codes a handler may refuse with. */
const KNOWN_STATUS: Record<string, number> = {
  validation: 422,
  conflict: 409,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  busy: 503,
};

/** Docs whose reasons the UI translates, and the catalog prefix it reads them from. */
const UI_REASON_PREFIX: Record<string, string | null> = {
  "datasources.md": "datasources.reason.",
  "plugins.md": "datasources.reason.",
  "mail.md": "datasources.reason.",
  "sso.md": "datasources.reason.",
  "ai.md": "ai.reason.",
  "access.md": null,
  "scim.md": null,
};

const CLIENT = "ui/src/api/client.ts";
const SNAKE = /^[a-z][a-z0-9_]*$/;
const REASON = /^[a-z_]+\.[a-z_]+$/;

function parseAccess(raw: string, authz: string): Access {
  const value = raw.trim().replace(/^Access::/, "");
  if (
    value === "Public" ||
    value === "Authenticated" ||
    value === "ServerAdmin" ||
    value === "OrgMember"
  ) {
    return { kind: value };
  }
  const permission = /^(?:Org\()?([a-z]+:[a-z]+)\)?$/.exec(value)?.[1];
  if (permission === undefined) {
    throw new Error(
      `access ${raw} is not Authenticated, ServerAdmin, OrgMember, Public or a permission like dashboards:write`,
    );
  }
  const variant = permissions(authz).get(permission);
  if (variant === undefined) {
    throw new Error(`${permission} is not a permission in ${AUTHZ}`);
  }
  return { kind: "Org", permission, variant };
}

function accessRust(access: Access): string {
  return access.kind === "Org"
    ? `Access::Org(Permission::${access.variant})`
    : `Access::${access.kind}`;
}

function checkPath(path: string, access: Access): void {
  if (!path.startsWith("/") || path.startsWith("/api/")) {
    throw new Error(`the path is relative to /api and starts with /: ${path}`);
  }
  const segments = path.slice(1).split("/");
  const first = segments[0];
  if (access.kind === "ServerAdmin" && first !== "admin") {
    throw new Error("ServerAdmin routes live under /admin (routes::access_guard)");
  }
  if (
    (access.kind === "Org" || access.kind === "OrgMember") &&
    (first !== "orgs" || segments[1] !== "{orgId}")
  ) {
    throw new Error("organization routes are /orgs/{orgId}/... (routes::access_guard)");
  }
  if (first === "admin" && access.kind !== "ServerAdmin") {
    throw new Error("routes under /admin must be ServerAdmin");
  }
  if (first === "orgs" && access.kind !== "Org" && access.kind !== "OrgMember") {
    throw new Error("routes under /orgs need the membership check (OrgMember or a permission)");
  }
}

/** Index of the bracket that closes the one at `open`, skipping string literals. */
function closing(source: string, open: number): number {
  const pairs: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i] ?? "";
    if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        i += source[i] === "\\" ? 2 : 1;
      }
      continue;
    }
    if (c in pairs) {
      stack.push(pairs[c] ?? "");
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        return i;
      }
    }
  }
  throw new Error("unbalanced brackets");
}

/** Adds an entry to the `vec![...]` of `pub fn routes()`. */
export function addRouteEntry(module: string, entry: string): string {
  const fn = module.indexOf("pub fn routes() -> Vec<RouteDef>");
  if (fn === -1) {
    throw new Error("the module has no `pub fn routes() -> Vec<RouteDef>`");
  }
  const open = module.indexOf("vec![", fn) + "vec!".length;
  const close = closing(module, open);
  const inner = module.slice(open + 1, close).trimEnd();
  const separator = inner === "" || inner.endsWith(",") ? "" : ",";
  return `${module.slice(0, open + 1)}${inner}${separator}\n        ${entry},\n    ${module.slice(close)}`;
}

/**
 * The names `use` statements bring into scope: the last segment of each path (`self` names its
 * parent, `as` its alias). `use crate::authz::Access::Authenticated` binds Authenticated, not Access.
 */
export function importedNames(uses: string[]): Set<string> {
  const names = new Set<string>();
  for (const use of uses) {
    const body = use.replace(/^use\s+/, "").replace(/;\s*$/, "");
    // Each leaf: split at braces and commas, keeping the path prefix of a group.
    const walk = (text: string, prefix: string) => {
      let depth = 0;
      let start = 0;
      const parts: string[] = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "{") depth++;
        if (c === "}") depth--;
        if (c === "," && depth === 0) {
          parts.push(text.slice(start, i));
          start = i + 1;
        }
      }
      parts.push(text.slice(start));
      for (const raw of parts) {
        const part = raw.trim();
        if (part === "") continue;
        const group = /^(.*?)::\{([\s\S]*)\}$/.exec(part);
        if (group !== null) {
          walk(group[2] ?? "", `${prefix}${group[1]}::`);
          continue;
        }
        const alias = /\bas\s+(\w+)$/.exec(part)?.[1];
        if (alias !== undefined) {
          names.add(alias);
          continue;
        }
        const segments = `${prefix}${part}`.split("::").map((s) => s.trim());
        const last = segments[segments.length - 1] ?? "";
        names.add(last === "self" ? (segments[segments.length - 2] ?? "") : last);
      }
    };
    walk(body, "");
  }
  return names;
}

/** `use` lines for names the module does not import yet. */
export function addImports(module: string, wanted: [string, string][]): string {
  const uses = [...module.matchAll(/^use [^;]+;/gms)];
  const imported = importedNames(uses.map((m) => m[0]));
  const missing = wanted.filter(([, name]) => !imported.has(name));
  if (missing.length === 0) {
    return module;
  }
  const external = missing.filter(([path]) => !/^(crate|super)\b/.test(path));
  const internal = missing.filter(([path]) => /^(crate|super)\b/.test(path));
  const lastUse = uses[uses.length - 1];
  if (lastUse === undefined) {
    const header = /^(\/\/![^\n]*\n)*\n?/.exec(module)?.[0] ?? "";
    const block = [...external, ...internal].map(([p, n]) => `use ${p}::${n};`).join("\n");
    return `${header}${block}\n\n${module.slice(header.length)}`;
  }
  // External names after the last external `use`, the crate's after the last one overall.
  const firstInternal = uses.find((m) => /^use (crate|super)\b/.test(m[0]));
  const externalUses = uses.filter((m) => !/^use (crate|super)\b/.test(m[0]));
  const lastExternal = externalUses[externalUses.length - 1];
  let out = module;
  const insertAt = (at: number, text: string) => {
    out = `${out.slice(0, at)}${text}${out.slice(at)}`;
  };
  const end = (m: RegExpMatchArray) => (m.index ?? 0) + m[0].length;
  const internalText = internal.map(([p, n]) => `\nuse ${p}::${n};`).join("");
  const externalText = external.map(([p, n]) => `\nuse ${p}::${n};`).join("");
  // Later position first, so the earlier index stays valid.
  if (internalText !== "") {
    insertAt(end(lastUse), internalText);
  }
  if (externalText !== "") {
    if (lastExternal !== undefined) {
      insertAt(end(lastExternal), externalText);
    } else if (firstInternal !== undefined) {
      insertAt(firstInternal.index ?? 0, `${externalText.slice(1)}\n\n`);
    }
  }
  return out;
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").filter((p) => p !== "orgId");
}

interface Plan {
  request: RouteRequest;
  access: Access;
  body: boolean;
  params: string[];
  errorCode: string;
  errorStatus: number;
  newErrorCode: boolean;
}

function handlerCode(plan: Plan): { code: string; imports: [string, string][] } {
  const { request, access, body, params } = plan;
  const imports: [string, string][] = [
    ["axum", "Json"],
    ["serde_json", "Value"],
    ["serde_json", "json"],
    ["crate::error", "ApiResult"],
  ];
  const args: string[] = [];
  const out: string[] = [];
  const fields: string[] = [];
  if (access.kind === "Org" || access.kind === "OrgMember") {
    imports.push(["axum", "Extension"], ["crate::authz", "OrgCtx"]);
    args.push("Extension(ctx): Extension<OrgCtx>");
    fields.push(`"orgId": ctx.org_id`);
  } else if (access.kind === "ServerAdmin" || access.kind === "Authenticated") {
    imports.push(["axum", "Extension"], ["crate::auth", "SessionUser"]);
    args.push("Extension(user): Extension<SessionUser>");
    fields.push(`"userId": user.id`);
  }
  if (params.length > 0) {
    imports.push(["axum::extract", "Path"], ["std::collections", "HashMap"]);
    args.push("Path(params): Path<HashMap<String, String>>");
    fields.push(`"params": params`);
  }
  const bodyType = `${pascal(request.handler)}Body`;
  if (body) {
    imports.push(["crate::extract", "JsonBody"], ["serde", "Deserialize"]);
    args.push(`JsonBody(body): JsonBody<${bodyType}>`);
  }
  if (access.kind === "Org") {
    imports.push(["crate::authz", "Permission"]);
  }
  const docsRef = `docs/api/${request.docs}, "\`${request.method} ${request.path}\`"`;
  if (body) {
    out.push("#[derive(Deserialize)]");
    out.push('#[serde(rename_all = "camelCase", deny_unknown_fields)]');
    out.push(`struct ${bodyType} {`);
    out.push("    name: String,");
    out.push("}");
    out.push("");
  }
  out.push(`/// ${request.summary.trim().replace(/\.$/, "")} (${docsRef}).`);
  out.push(`async fn ${request.handler}(${args.join(", ")}) -> ApiResult<Json<Value>> {`);
  out.push(
    "    // The route table enforces the access before this runs; checking it here again keeps the",
  );
  out.push("    // rule next to the code it protects and survives a change of the table entry.");
  if (access.kind === "Org") {
    out.push(`    ctx.check(Permission::${access.variant})?;`);
  } else if (access.kind === "ServerAdmin") {
    imports.push(["crate::error", "ApiError"]);
    out.push("    if user.is_server_admin == 0 {");
    out.push('        return Err(ApiError::forbidden("server administrators only"));');
    out.push("    }");
  } else if (access.kind === "OrgMember") {
    out.push(
      "    // Members only: the context exists only for a member of the path's organization",
    );
    out.push("    // (`routes::table::org_ctx`); non-members got `not_found` before this ran.");
  } else if (access.kind === "Authenticated") {
    out.push(
      "    // Any signed-in person: `user` is the caller, never someone named in the request.",
    );
  }
  if (body) {
    out.push("    let name = body.name.trim();");
    out.push("    if name.is_empty() {");
    const refusal =
      plan.errorCode === "validation"
        ? `ApiError::validation("name must not be empty")`
        : `ApiError::new(StatusCode::${STATUS[plan.errorStatus] ?? "UNPROCESSABLE_ENTITY"}, "${plan.errorCode}", "name must not be empty")`;
    if (plan.errorCode !== "validation") {
      imports.push(["axum::http", "StatusCode"]);
    }
    imports.push(["crate::error", "ApiError"]);
    const because = request.reason === undefined ? "" : `.because("${request.reason}")`;
    out.push(`        return Err(${refusal}.with_field("name")${because});`);
    out.push("    }");
    fields.push(`"name": name`);
  }
  out.push(`    Ok(Json(json!({ ${fields.join(", ")} })))`);
  out.push("}");
  const unique = imports.filter(
    ([p, n], i) => imports.findIndex(([q, m]) => q === p && m === n) === i,
  );
  return { code: out.join("\n"), imports: unique };
}

function newModule(
  plan: Plan,
  entry: string,
  handler: string,
  imports: [string, string][],
): string {
  const title = plan.request.title ?? pascal(plan.request.module);
  const all: [string, string][] = [
    ["axum::http", "Method"],
    ...imports,
    ["super::table", "RouteDef"],
    ["super::table", "route"],
    ["crate::authz", "Access"],
  ];
  const std = all.filter(([p]) => /^std\b/.test(p));
  const external = all.filter(([p]) => !/^(crate|super|std)\b/.test(p));
  const internal = all.filter(([p]) => /^(crate|super)\b/.test(p));
  const lines = (list: [string, string][]) => {
    const byPath = new Map<string, string[]>();
    for (const [p, n] of list) {
      byPath.set(p, [...(byPath.get(p) ?? []), n]);
    }
    return [...byPath]
      .map(([p, names]) =>
        names.length === 1 ? `use ${p}::${names[0]};` : `use ${p}::{${names.join(", ")}};`,
      )
      .join("\n");
  };
  return [
    ...wrap(
      `${title} (docs/api/${plan.request.docs}): ${plan.request.summary.trim().replace(/\.$/, "")}.`,
      96,
    ).map((line) => `//! ${line}`),
    "",
    ...(std.length > 0 ? [lines(std), ""] : []),
    lines(external),
    "",
    lines(internal),
    "",
    "pub fn routes() -> Vec<RouteDef> {",
    `    vec![${entry}]`,
    "}",
    "",
    handler,
    "",
  ].join("\n");
}

function insertHandler(module: string, handler: string): string {
  const tests = module.search(/\n#\[cfg\(test\)\]\nmod tests/);
  if (tests === -1) {
    return `${module.trimEnd()}\n\n${handler}\n`;
  }
  return `${module.slice(0, tests).trimEnd()}\n\n${handler}\n${module.slice(tests)}`;
}

/** Adds the module to routes/mod.rs: `pub mod` in order and its `routes()` in `all()`. */
export function registerModule(mod: string, module: string): string {
  const modLines = mod.split("\n");
  const firstMod = modLines.findIndex((l) => /^pub mod \w+;$/.test(l));
  let at = firstMod;
  while (
    at < modLines.length &&
    /^(pub mod \w+;|mod \w+;|#\[cfg\(test\)\])$/.test(modLines[at] ?? "")
  ) {
    const name = /^pub mod (\w+);$/.exec(modLines[at] ?? "")?.[1];
    if (name !== undefined && name > module) {
      break;
    }
    at++;
  }
  // A `#[cfg(test)]` line belongs to the module after it.
  if (modLines[at - 1] === "#[cfg(test)]") {
    at--;
  }
  modLines.splice(at, 0, `pub mod ${module};`);
  let out = modLines.join("\n");
  out = out.replace(
    /(\n {4}\]\n {4}\.into_iter\(\)\n {4}\.flatten\(\))/,
    `\n        ${module}::routes(),$1`,
  );
  if (!out.includes(`${module}::routes(),`)) {
    throw new Error(`could not add ${module}::routes() to all() in ${ROUTES_MOD}`);
  }
  return out;
}

/** Adds "METHOD path" to the PUBLIC or AUTHENTICATED list of routes::access_guard. */
export function addToGuardList(
  mod: string,
  list: "PUBLIC" | "AUTHENTICATED",
  key: string,
  comment: string,
): string {
  const pattern = new RegExp(`(const ${list}: &\\[&str\\] = &\\[[\\s\\S]*?)(\\n\\s*\\];)`);
  if (!pattern.test(mod)) {
    throw new Error(`${list} not found in ${ROUTES_MOD}`);
  }
  return mod.replace(pattern, `$1\n        // ${comment}\n        "${key}",$2`);
}

function docsSection(plan: Plan): string {
  const { request, access } = plan;
  const who: Record<Access["kind"], string> = {
    Public: "anyone, without a session",
    Authenticated: "any signed-in person",
    ServerAdmin: "server administrators",
    OrgMember: "members of the organization",
    Org: access.kind === "Org" ? `members with \`${access.permission}\`` : "",
  };
  const refusals: string[] = [];
  if (access.kind !== "Public") {
    refusals.push("`401 unauthenticated` without a session");
  }
  if (access.kind === "ServerAdmin") {
    refusals.push("`403 forbidden` for everyone else");
  }
  if (access.kind === "Org" || access.kind === "OrgMember") {
    refusals.push("`404 not_found` for non-members");
  }
  if (access.kind === "Org") {
    refusals.push(`\`403 forbidden\` without \`${access.permission}\``);
  }
  if (plan.body) {
    const reason = request.reason === undefined ? "" : ` (reason \`${request.reason}\`)`;
    refusals.push(
      `\`${plan.errorStatus} ${plan.errorCode}\` on \`name\` when it is empty${reason}`,
    );
  }
  const body = plan.body ? ' Body: `{ "name": string }`.' : "";
  const paragraph = `Access: ${who[access.kind]}.${body} Answers \`200\` with the result. Refused: ${refusals.join("; ")}.`;
  const lines = [
    `### \`${request.method} ${request.path}\``,
    "",
    `${request.summary.trim().replace(/\.$/, "")}.`,
    "",
    ...wrap(paragraph, 100),
    "",
  ];
  return lines.join("\n");
}

/** Words wrapped at `width` columns, as the docs are. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") {
    out.push(line);
  }
  return out;
}

/** Inserts a section before `## Reasons` (or `## Not here yet`), else at the end. */
export function insertDocsSection(doc: string, section: string): string {
  const text = doc.replace(/\r\n/g, "\n");
  for (const heading of ["\n## Reasons", "\n## Not here yet"]) {
    const at = text.indexOf(heading);
    if (at !== -1) {
      return `${text.slice(0, at).trimEnd()}\n\n${section}${text.slice(at)}`;
    }
  }
  return `${text.trimEnd()}\n\n${section}`;
}

/** Adds a row to the `### title` table of the Reasons section, creating section and table. */
export function insertReasonRow(doc: string, title: string, row: string): string {
  let text = doc.replace(/\r\n/g, "\n").trimEnd();
  if (!text.includes("\n## Reasons")) {
    const notYet = text.indexOf("\n## Not here yet");
    const block = "\n\n## Reasons\n";
    text =
      notYet === -1 ? `${text}${block}` : `${text.slice(0, notYet)}${block}${text.slice(notYet)}`;
  }
  const start = text.indexOf("\n## Reasons");
  const nextHeading = text.indexOf("\n## ", start + 1);
  const end = nextHeading === -1 ? text.length : nextHeading;
  const section = text.slice(start, end);
  const sub = section.indexOf(`\n### ${title}\n`);
  let updated: string;
  if (sub === -1) {
    updated = `${section.trimEnd()}\n\n### ${title}\n\n| Reason | Params | When |\n|---|---|---|\n${row}\n`;
  } else {
    const subEnd = section.indexOf("\n### ", sub + 1);
    const part = section.slice(sub, subEnd === -1 ? section.length : subEnd);
    const lines = part.split("\n");
    let last = -1;
    lines.forEach((line, i) => {
      if (line.startsWith("|")) {
        last = i;
      }
    });
    if (last === -1) {
      lines.push("", "| Reason | Params | When |", "|---|---|---|", row);
    } else {
      lines.splice(last + 1, 0, row);
    }
    updated = `${section.slice(0, sub)}${lines.join("\n")}${subEnd === -1 ? "" : section.slice(subEnd)}`;
    updated = `${updated.trimEnd()}\n`;
  }
  const after = text.slice(end);
  return `${text.slice(0, start)}${updated}${after === "" ? "" : `${after.startsWith("\n") ? "" : "\n"}${after}`}`.replace(
    /\n*$/,
    "\n",
  );
}

function testCode(plan: Plan, testName: string): string {
  const { request, access } = plan;
  const roles = rolePermissions(readText(join(rootOf(plan), AUTHZ)));
  const weakestWithout =
    access.kind === "Org" ? roles.find(([, set]) => !set.has(access.variant))?.[0] : undefined;
  const filled = (org: string) =>
    `&format!("/api${request.path.replace("{orgId}", "{org}").replace(/\{(?!org\})(\w+)\}/g, "00000000-0000-7000-8000-000000000001")}", org = ${org})`;
  const usesOrgInPath = request.path.includes("{orgId}");
  const pathExpr = usesOrgInPath
    ? filled("t.org")
    : `"/api${request.path.replace(/\{(\w+)\}/g, "00000000-0000-7000-8000-000000000001")}"`;
  const method = `Method::${request.method}`;
  const body = plan.body ? `Some(json!({ "name": "Beispiel" }))` : "None";
  const needsSecondOrg =
    access.kind === "OrgMember" || (access.kind === "Org" && weakestWithout === undefined);
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  const header = wrap(
    `\`${request.method} ${request.path}\` through the real router and database (docs/api/${request.docs}): ${request.summary.trim().replace(/\.$/, "")}. Covers the allowed, forbidden and unauthenticated cases; add the route's own behavior here.`,
    96,
  );
  push(
    ...header.map((line) => `//! ${line}`),
    "",
    "use std::net::SocketAddr;",
    "use std::sync::Arc;",
    "",
    "use axum::Router;",
    "use axum::body::Body;",
    "use axum::extract::connect_info::MockConnectInfo;",
    "use axum::http::{Method, Request, StatusCode, header};",
    "use http_body_util::BodyExt;",
    "use kalzit::app::{AppState, router};",
    "use kalzit::clock::{Clock, ManualClock};",
    "use kalzit::config::Config;",
    "use serde_json::{Value, json};",
    "use tower::ServiceExt;",
    "",
    "mod common;",
    "",
    'const SETUP_CODE: &str = "test-setup-code-0123456789";',
    "const T0: i64 = 1_800_000_000_000;",
    "",
    "struct TestApp {",
    "    app: Router,",
    "    clock: Arc<ManualClock>,",
    "    state: AppState,",
    "    dir: tempfile::TempDir,",
    "    owner: String,",
    "    org: String,",
    "}",
    "",
    "struct Reply {",
    "    status: StatusCode,",
    "    body: Value,",
    "}",
    "",
    "/// A fresh server on SQLite whose setup made `owner` (server admin and owner of `org`).",
    "async fn test_app() -> TestApp {",
    "    let dir = common::private_tempdir();",
    "    let mut config = Config::default();",
    "    config.paths.data_dir = dir.path().to_path_buf();",
    "    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();",
    "    let clock = Arc::new(ManualClock::new(T0));",
    "    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();",
    '    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();',
    "    let app = router(state.clone()).layer(MockConnectInfo(peer));",
    "    let mut t = TestApp { app, clock, state, dir, owner: String::new(), org: String::new() };",
    "    let setup = t",
    "        .send(",
    "            Method::POST,",
    '            "/api/setup",',
    '            Some(json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",',
    '                         "email": "joerg@example.de", "password": "Grün und sicher 2026" })),',
    "            None,",
    "        )",
    "        .await;",
    '    assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);',
    '    t.org = setup.body["orgs"][0]["id"].as_str().unwrap().to_string();',
    '    let owner_id = setup.body["id"].as_str().unwrap().to_string();',
    "    t.owner = t.session_for(&owner_id).await;",
    "    t",
    "}",
    "",
    "impl TestApp {",
    "    async fn send(&self, method: Method, path: &str, body: Option<Value>, cookie: Option<&str>) -> Reply {",
    '        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");',
    "        if let Some(c) = cookie {",
    "            req = req.header(header::COOKIE, c);",
    "        }",
    "        let req = match body {",
    '            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),',
    "            None => req.body(Body::empty()),",
    "        }",
    "        .unwrap();",
    "        let res = self.app.clone().oneshot(req).await.unwrap();",
    "        let status = res.status();",
    "        let bytes = res.into_body().collect().await.unwrap().to_bytes();",
    "        Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }",
    "    }",
    "",
    "    async fn session_for(&self, user_id: &str) -> String {",
    "        let cfg = &self.state.config.sessions;",
    "        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), user_id).await.unwrap();",
    '        format!("kalzit_session={token}")',
    "    }",
    "",
    "    /// A new person who is a member of `org` with `role`; answers their session cookie.",
    "    async fn member_of(&self, org: &str, name: &str, role: &str) -> String {",
    "        let id = uuid::Uuid::now_v7().to_string();",
    '        sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, 0)")',
    "            .bind(&id)",
    '            .bind(format!("{}@example.de", name.to_lowercase()))',
    "            .bind(name)",
    "            .execute(&self.state.db)",
    "            .await",
    "            .unwrap();",
    '        sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, 0)")',
    "            .bind(org)",
    "            .bind(&id)",
    "            .bind(role)",
    "            .execute(&self.state.db)",
    "            .await",
    "            .unwrap();",
    "        self.session_for(&id).await",
    "    }",
    "",
    "    /// Closes the app and deletes its data directory (`common::Finish`).",
    "    async fn finish(self) {",
    "        let TestApp { app, state, dir, .. } = self;",
    "        drop(app);",
    "        common::Finish::new(state, Arc::new(dir)).finish().await;",
    "    }",
  );
  if (needsSecondOrg) {
    push(
      "",
      "    /// Another organization, for people who are not members of `org`.",
      "    async fn second_org(&self) -> String {",
      "        let id = uuid::Uuid::now_v7().to_string();",
      `        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Zweite GmbH', 0)")`,
      "            .bind(&id)",
      "            .execute(&self.state.db)",
      "            .await",
      "            .unwrap();",
      "        id",
      "    }",
    );
  }
  push("}", "");
  const call = (cookie: string, bodyExpr = body) =>
    `t.send(${method}, ${pathExpr}, ${bodyExpr}, ${cookie}).await`;

  push(
    "#[tokio::test]",
    `async fn ${testName}_answers_the_allowed_caller() {`,
    "    let t = test_app().await;",
    `    let r = ${call("Some(t.owner.as_str())")};`,
    '    assert_eq!(r.status, StatusCode::OK, "{}", r.body);',
    "    t.finish().await;",
    "}",
    "",
  );
  if (access.kind === "ServerAdmin" || (access.kind === "Org" && weakestWithout !== undefined)) {
    const role = access.kind === "ServerAdmin" ? "owner" : (weakestWithout ?? "viewer");
    const why =
      access.kind === "ServerAdmin"
        ? "An organization owner who is not a server administrator."
        : `A ${role}, whose role lacks ${access.kind === "Org" ? access.permission : ""}.`;
    push(
      "#[tokio::test]",
      `async fn ${testName}_refuses_without_the_right() {`,
      "    let t = test_app().await;",
      `    // ${why}`,
      `    let other = t.member_of(&t.org, "Vera", "${role}").await;`,
      `    let r = ${call("Some(other.as_str())")};`,
      '    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);',
      '    assert_eq!(r.body["error"]["code"], "forbidden");',
      "    t.finish().await;",
      "}",
      "",
    );
  }
  if (needsSecondOrg) {
    push(
      "#[tokio::test]",
      `async fn ${testName}_refuses_non_members() {`,
      "    let t = test_app().await;",
      "    // A member of another organization learns nothing about this one.",
      "    let elsewhere = t.second_org().await;",
      '    let stranger = t.member_of(&elsewhere, "Sven", "owner").await;',
      `    let r = ${call("Some(stranger.as_str())")};`,
      '    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);',
      "    t.finish().await;",
      "}",
      "",
    );
  }
  if (access.kind === "Authenticated") {
    push(
      "#[tokio::test]",
      `async fn ${testName}_answers_any_signed_in_person() {`,
      "    let t = test_app().await;",
      "    // Authenticated routes have no forbidden case: they act on the caller only.",
      '    let viewer = t.member_of(&t.org, "Vera", "viewer").await;',
      `    let r = ${call("Some(viewer.as_str())")};`,
      '    assert_eq!(r.status, StatusCode::OK, "{}", r.body);',
      "    t.finish().await;",
      "}",
      "",
    );
  }
  if (access.kind !== "Public") {
    push(
      "#[tokio::test]",
      `async fn ${testName}_needs_a_session() {`,
      "    let t = test_app().await;",
      `    let r = ${call("None")};`,
      '    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.body);',
      '    assert_eq!(r.body["error"]["code"], "unauthenticated");',
      "    t.finish().await;",
      "}",
      "",
    );
  }
  if (plan.body) {
    const statusConst = STATUS[plan.errorStatus] ?? "UNPROCESSABLE_ENTITY";
    push(
      "#[tokio::test]",
      `async fn ${testName}_refuses_an_empty_name() {`,
      "    let t = test_app().await;",
      `    let r = ${call("Some(t.owner.as_str())", `Some(json!({ "name": "  " }))`)};`,
      `    assert_eq!(r.status, StatusCode::${statusConst}, "{}", r.body);`,
      `    assert_eq!(r.body["error"]["code"], "${plan.errorCode}");`,
      ...(request.reason === undefined
        ? []
        : [`    assert_eq!(r.body["error"]["reason"], "${request.reason}");`]),
      "    t.finish().await;",
      "}",
      "",
    );
  }
  return lines.join("\n");
}

const roots = new WeakMap<Plan, string>();
function rootOf(plan: Plan): string {
  return roots.get(plan) ?? "";
}

/** One line of text: the summary and title end up in doc comments and Markdown headings. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function scaffoldRoute(root: string, input: RouteRequest): ScaffoldResult {
  const request: RouteRequest = {
    ...input,
    summary: oneLine(input.summary),
    ...(input.title === undefined ? {} : { title: oneLine(input.title) }),
  };
  const changed = new Set<string>();
  const created: string[] = [];
  const next: string[] = [];
  const warnings: string[] = [];
  if (!SNAKE.test(request.module) || !SNAKE.test(request.handler)) {
    throw new Error("module and handler are snake_case names");
  }
  if (!METHODS.includes(request.method)) {
    throw new Error(`method is one of ${METHODS.join(", ")}`);
  }
  if (request.summary.trim() === "") {
    throw new Error("the route needs a one-sentence summary");
  }
  if (!/^[\w-]+\.md$/.test(request.docs)) {
    throw new Error("docs is a file name under docs/api, such as dashboard-features.md");
  }
  const authz = readText(join(root, AUTHZ));
  const access = parseAccess(request.access, authz);
  checkPath(request.path, access);
  const body = request.method === "POST" || request.method === "PUT" || request.method === "PATCH";
  if (request.reason !== undefined) {
    if (!REASON.test(request.reason)) {
      throw new Error(`${request.reason} is not a reason like widgets.name_missing`);
    }
    if (!body) {
      throw new Error("a reason belongs to a route with a body (POST, PUT or PATCH)");
    }
  }
  const errorCode = request.errorCode ?? "validation";
  const existingCodes = errorCodes(readText(join(root, ERROR)));
  const newErrorCode = !existingCodes.includes(errorCode);
  let errorStatus = KNOWN_STATUS[errorCode] ?? request.errorStatus ?? 0;
  if (!SNAKE.test(errorCode)) {
    throw new Error(`${errorCode} is not an error code like conflict`);
  }
  if (newErrorCode) {
    if (request.errorStatus === undefined || STATUS[request.errorStatus] === undefined) {
      throw new Error(
        `a new error code needs errorStatus, one of ${Object.keys(STATUS).join(", ")}`,
      );
    }
    if (request.errorEn === undefined || request.errorDe === undefined) {
      throw new Error("a new error code needs errorEn and errorDe, the UI's texts for it");
    }
    errorStatus = request.errorStatus;
  } else if (KNOWN_STATUS[errorCode] === undefined) {
    throw new Error(
      `${errorCode} is not a code a handler refuses input with; use validation or conflict`,
    );
  }
  // The same method and path must not be declared twice.
  const routesDir = join(root, "server", "src", "routes");
  for (const file of readdirSync(routesDir)) {
    if (
      file.endsWith(".rs") &&
      readText(join(routesDir, file)).includes(`route(Method::${request.method}, "${request.path}"`)
    ) {
      throw new Error(`${request.method} ${request.path} is declared already in routes/${file}`);
    }
  }
  const plan: Plan = {
    request,
    access,
    body,
    params: pathParams(request.path),
    errorCode,
    errorStatus,
    newErrorCode,
  };
  roots.set(plan, root);

  // 1. Route table entry and handler.
  const modulePath = join(routesDir, `${request.module}.rs`);
  const entry = `route(Method::${request.method}, "${request.path}", ${accessRust(access)}, ${request.handler})`;
  const { code, imports } = handlerCode(plan);
  const accessImports: [string, string][] = [["crate::authz", "Access"]];
  if (existsSync(modulePath)) {
    let module = readText(modulePath);
    if (new RegExp(`\\bfn ${request.handler}\\b`).test(module)) {
      throw new Error(`routes/${request.module}.rs has a function ${request.handler} already`);
    }
    module = addRouteEntry(module, entry);
    module = insertHandler(module, code);
    module = addImports(module, [...imports, ...accessImports, ["axum::http", "Method"]]);
    writeText(modulePath, module);
    changed.add(`server/src/routes/${request.module}.rs`);
  } else {
    writeText(modulePath, newModule(plan, entry, code, imports));
    created.push(`server/src/routes/${request.module}.rs`);
    const modFile = join(root, ROUTES_MOD);
    writeText(modFile, registerModule(readText(modFile), request.module));
    changed.add(ROUTES_MOD);
  }

  // 2. The access guard lists for routes that are not scoped by their path.
  if (access.kind === "Authenticated" || access.kind === "Public") {
    const modFile = join(root, ROUTES_MOD);
    const list = access.kind === "Public" ? "PUBLIC" : "AUTHENTICATED";
    const comment =
      access.kind === "Public"
        ? `${request.summary.trim().replace(/\.$/, "")}. Public: reviewed decision, rate-limit it.`
        : `${request.summary.trim().replace(/\.$/, "")} (\`routes::${request.module}\`).`;
    writeText(
      modFile,
      addToGuardList(readText(modFile), list, `${request.method} ${request.path}`, comment),
    );
    changed.add(ROUTES_MOD);
    if (access.kind === "Public") {
      warnings.push(
        "public routes are a reviewed decision: say why in the PR and limit them per address",
      );
    }
  }

  // 3. A new error code: ERROR_CODES, the generated union and the UI's texts.
  const uiFiles: string[] = [];
  if (newErrorCode) {
    const errorFile = join(root, ERROR);
    const updated = addErrorCode(readText(errorFile), errorCode);
    writeText(errorFile, updated);
    changed.add(ERROR);
    const shapesFile = join(root, SHAPES);
    writeText(shapesFile, setUnion(readText(shapesFile), "ErrorCode", errorCodes(updated)));
    changed.add(SHAPES);
    // The client's runtime list of codes, a Record over the generated union.
    const clientFile = join(root, CLIENT);
    const client = readText(clientFile);
    const withCode = client.replace(/(\n {2}internal: true,\n\};)/, `\n  ${errorCode}: true,$1`);
    if (withCode === client) {
      throw new Error(`cannot add ${errorCode} to SERVER_ERROR_CODE_SET in ${CLIENT}`);
    }
    writeText(clientFile, withCode);
    changed.add(CLIENT);
    uiFiles.push(clientFile);
    const key = `errors.${errorCode}`;
    warnings.push(
      ...messageProblems(root, key, { de: request.errorDe ?? "", en: request.errorEn ?? "" }),
    );
    for (const language of LANGUAGES) {
      const file = join(root, "ui", "src", "i18n", language, "core.json");
      writeText(
        file,
        insertEntry(
          readText(file),
          key,
          language === "de" ? (request.errorDe ?? "") : (request.errorEn ?? ""),
        ),
      );
      changed.add(`ui/src/i18n/${language}/core.json`);
      uiFiles.push(file);
    }
  }

  // 4. The reason: namespace of the reasons check, the docs row and the UI texts.
  if (request.reason !== undefined) {
    const reasonDocs = request.reasonDocs ?? request.docs;
    if (!(reasonDocs in UI_REASON_PREFIX)) {
      throw new Error(
        `the reasons check reads ${Object.keys(UI_REASON_PREFIX).join(", ")}; pass reasonDocs as one of them`,
      );
    }
    const namespace = request.reason.split(".")[0] ?? "";
    const detailFile = join(root, DETAIL);
    const detail = readText(detailFile);
    if (!namespaces(detail).includes(namespace)) {
      writeText(
        detailFile,
        addNamespace(
          detail,
          namespace,
          `${request.title ?? pascal(request.module)} (docs/api/${reasonDocs}).`,
        ),
      );
      changed.add(DETAIL);
    }
    const docFile = join(root, "docs", "api", reasonDocs);
    if (!existsSync(docFile)) {
      throw new Error(`docs/api/${reasonDocs} does not exist`);
    }
    const when = `\`${errorStatus} ${errorCode}\` on \`name\`: the name is empty`;
    const row = `| \`${request.reason}\` | | ${when} |`;
    writeText(
      docFile,
      insertReasonRow(readText(docFile), request.title ?? pascal(request.module), row),
    );
    changed.add(`docs/api/${reasonDocs}`);
    const prefix = UI_REASON_PREFIX[reasonDocs];
    if (prefix !== null && prefix !== undefined) {
      if (request.reasonEn === undefined || request.reasonDe === undefined) {
        throw new Error(`docs/api/${reasonDocs} reasons need UI texts: pass reasonEn and reasonDe`);
      }
      const key = `${prefix}${request.reason}`;
      warnings.push(...messageProblems(root, key, { de: request.reasonDe, en: request.reasonEn }));
      const area = areaFor(readCatalogs(root), key);
      for (const language of LANGUAGES) {
        const file = join(root, "ui", "src", "i18n", language, `${area}.json`);
        writeText(
          file,
          insertEntry(readText(file), key, language === "de" ? request.reasonDe : request.reasonEn),
        );
        changed.add(`ui/src/i18n/${language}/${area}.json`);
        uiFiles.push(file);
      }
    }
  }

  // 5. The docs section.
  const docsFile = join(root, "docs", "api", request.docs);
  const section = docsSection(plan);
  if (existsSync(docsFile)) {
    writeText(docsFile, insertDocsSection(readText(docsFile), section));
    changed.add(`docs/api/${request.docs}`);
  } else {
    writeText(docsFile, `# API: ${request.title ?? pascal(request.module)}\n\n${section}`);
    created.push(`docs/api/${request.docs}`);
  }

  // 6. The integration test.
  const testName = request.handler;
  const testFile = join(root, "server", "tests", `${request.module}_${request.handler}.rs`);
  if (existsSync(testFile)) {
    throw new Error(`server/tests/${request.module}_${request.handler}.rs exists already`);
  }
  writeText(testFile, testCode(plan, testName));
  created.push(`server/tests/${request.module}_${request.handler}.rs`);

  if (request.format !== false) {
    const rustFiles = [...changed, ...created]
      .filter((f) => f.endsWith(".rs"))
      .map((f) => join(root, f));
    const rustWarning = formatRust(root, rustFiles);
    if (rustWarning !== undefined) {
      warnings.push(rustWarning);
    }
    const uiWarning = formatUi(root, uiFiles);
    if (uiWarning !== undefined) {
      warnings.push(uiWarning);
    }
  }
  next.push(
    `fill in the handler in server/src/routes/${request.module}.rs (State(state): State<AppState> reads the database)`,
    `cargo test --test ${request.module}_${request.handler}`,
    "move the docs section under the heading it belongs to and describe the answer",
  );
  if (newErrorCode) {
    next.push("cargo test generated_typescript_is_current confirms the ErrorCode union");
  }
  return { changed: [...changed].filter((f) => !created.includes(f)), created, next, warnings };
}
