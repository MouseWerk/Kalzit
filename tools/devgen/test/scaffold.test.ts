import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { i18nCheck } from "../src/lib/i18n.ts";
import {
  addImports,
  addRouteEntry,
  importedNames,
  scaffoldRoute,
} from "../src/lib/routeScaffold.ts";
import { notReasons, registryKeys } from "../src/lib/rust.ts";
import { scaffoldSetting } from "../src/lib/settingScaffold.ts";
import { PROOF_ROUTES, PROOF_SETTINGS } from "../src/proof.ts";
import { scaffoldFixture } from "./helpers.ts";

/**
 * The scaffolds against a copy of the repository's files. The full proof (cargo fmt, clippy, the
 * generated tests, Biome, typecheck and UI tests) is `npm run proof`, run by CI; these tests keep
 * the text-level contract and the translation checks fast.
 */

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function fixture(): string {
  const tree = scaffoldFixture();
  cleanup = tree.done;
  return tree.dir;
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

describe("scaffold_route", () => {
  it("wires a new module, its reason, docs, texts and test, and the catalogs stay valid", () => {
    const root = fixture();
    const request = { ...PROOF_ROUTES[0], format: false } as (typeof PROOF_ROUTES)[number];
    const result = scaffoldRoute(root, request);
    expect(result.created).toEqual([
      "server/src/routes/devgen_proof.rs",
      "server/tests/devgen_proof_rename_item.rs",
    ]);
    const module = read(root, "server/src/routes/devgen_proof.rs");
    expect(module).toContain(
      'route(Method::POST, "/orgs/{orgId}/devgen-proof/{itemId}", Access::Org(Permission::DashboardsWrite), rename_item)',
    );
    expect(module).toContain("ctx.check(Permission::DashboardsWrite)?;");
    expect(module).toContain('.because("devgen_proof.name_missing")');
    const mod = read(root, "server/src/routes/mod.rs");
    expect(mod).toContain("pub mod devgen_proof;");
    expect(mod).toContain("devgen_proof::routes(),");
    expect(read(root, "server/src/datasources/detail.rs")).toContain('"devgen_proof",');
    expect(read(root, "docs/api/datasources.md")).toContain("| `devgen_proof.name_missing` | |");
    expect(read(root, "docs/api/dashboard-features.md")).toContain(
      "### `POST /orgs/{orgId}/devgen-proof/{itemId}`",
    );
    const test = read(root, "server/tests/devgen_proof_rename_item.rs");
    // A viewer lacks dashboards:write: the forbidden case uses that role.
    expect(test).toContain('t.member_of(&t.org, "Vera", "viewer")');
    expect(test).toContain("StatusCode::UNAUTHORIZED");
    expect(test).toContain('assert_eq!(r.body["error"]["reason"], "devgen_proof.name_missing");');
    expect(
      i18nCheck(root, { keys: ["datasources.reason.devgen_proof.name_missing"] }).errors,
    ).toEqual([]);
  });

  it("registers a new error code everywhere the server and UI list them", () => {
    const root = fixture();
    scaffoldRoute(root, { ...(PROOF_ROUTES[1] as (typeof PROOF_ROUTES)[number]), format: false });
    expect(read(root, "server/src/error.rs")).toMatch(/"devgen_proof_taken",\n\s*"internal",\n\];/);
    expect(read(root, "ui/src/api/generated/shapes.ts")).toContain(
      '| "devgen_proof_taken" | "internal";',
    );
    expect(read(root, "ui/src/api/client.ts")).toContain(
      "  devgen_proof_taken: true,\n  internal: true,",
    );
    expect(read(root, "server/tests/devgen_proof_claim_item.rs")).toContain("refuses_non_members");
    expect(i18nCheck(root, { keys: ["errors.devgen_proof_taken"] }).errors).toEqual([]);
  });

  it("adds a session-only route to the guard list of routes::access_guard", () => {
    const root = fixture();
    scaffoldRoute(root, { ...(PROOF_ROUTES[3] as (typeof PROOF_ROUTES)[number]), format: false });
    expect(read(root, "server/src/routes/mod.rs")).toContain('"GET /me/devgen-proof",');
    expect(read(root, "server/src/routes/me.rs")).toContain(
      'route(Method::GET, "/me/devgen-proof", Access::Authenticated, own_proof)',
    );
  });

  it("refuses paths that break the access layout and routes declared twice", () => {
    const root = fixture();
    const base = {
      module: "x",
      method: "GET",
      handler: "h",
      summary: "S",
      docs: "usage.md",
      format: false,
    } as const;
    expect(() =>
      scaffoldRoute(root, { ...base, path: "/orgs/{orgId}/x", access: "ServerAdmin" }),
    ).toThrow(/admin/);
    expect(() =>
      scaffoldRoute(root, { ...base, path: "/admin/x", access: "dashboards:read" }),
    ).toThrow(/orgs/);
    expect(() =>
      scaffoldRoute(root, { ...base, path: "/orgs/{orgId}/x", access: "nope:read" }),
    ).toThrow(/permission/);
    expect(() =>
      scaffoldRoute(root, { ...base, path: "/admin/usage", access: "ServerAdmin" }),
    ).toThrow(/declared already/);
  });

  it("knows which names a use statement binds", () => {
    const names = importedNames([
      "use axum::{Extension, Json};",
      "use crate::auth::{SessionUser, password::{self, hash}};",
      "use crate::authz::Access::Authenticated;",
      "use serde_json::Value as Json2;",
    ]);
    expect([...names].sort()).toEqual([
      "Authenticated",
      "Extension",
      "Json",
      "Json2",
      "SessionUser",
      "hash",
      "password",
    ]);
    const module = "//! Doc.\n\nuse axum::Json;\n\nuse crate::error::ApiResult;\n\nfn a() {}\n";
    expect(
      addImports(module, [
        ["axum", "Extension"],
        ["crate::authz", "OrgCtx"],
        ["axum", "Json"],
      ]),
    ).toBe(
      "//! Doc.\n\nuse axum::Json;\nuse axum::Extension;\n\nuse crate::error::ApiResult;\nuse crate::authz::OrgCtx;\n\nfn a() {}\n",
    );
    expect(
      addRouteEntry("pub fn routes() -> Vec<RouteDef> {\n    vec![route(a)]\n}\n", "route(b)"),
    ).toBe("pub fn routes() -> Vec<RouteDef> {\n    vec![route(a),\n        route(b),\n    ]\n}\n");
  });
});

describe("scaffold_setting", () => {
  it("adds registry entry, rule, generated key, texts, section row, docs and tests", () => {
    const root = fixture();
    const request = { ...(PROOF_SETTINGS[0] as (typeof PROOF_SETTINGS)[number]), format: false };
    const result = scaffoldSetting(root, request);
    const settings = read(root, "server/src/settings.rs");
    expect(registryKeys(settings)).toContain("audit.devgen_proof_days");
    // Next to the other audit setting.
    expect(registryKeys(settings).indexOf("audit.devgen_proof_days")).toBe(
      registryKeys(settings).indexOf("audit.retention_days") + 1,
    );
    expect(settings).toContain('"audit.devgen_proof_days" => Rule::Int { min: 1, max: 3650 },');
    expect(read(root, "ui/src/api/generated/shapes.ts")).toContain(
      '"audit.retention_days" | "audit.devgen_proof_days"',
    );
    expect(read(root, "ui/src/features/settings/sections.ts")).toContain(
      '"audit.devgen_proof_days",',
    );
    expect(read(root, "docs/api/settings-dashboards.md")).toContain(
      "| `audit.devgen_proof_days` | `30` | whole number 1 to 3650 |",
    );
    expect(result.created).toContain("server/tests/setting_audit_devgen_proof_days.rs");
    expect(read(root, "server/tests/setting_audit_devgen_proof_days.rs")).toContain(
      '"KALZIT_SETTING_AUDIT_DEVGEN_PROOF_DAYS"',
    );
    expect(read(root, "ui/src/i18n/en/settings.json")).toMatch(
      /"settings\.section\.storage\.keywords": "[^"]* proof"/,
    );
    expect(i18nCheck(root).errors).toEqual([]);
  });

  it("lists a key in a reasons namespace as a non-reason and adds the choices' names", () => {
    const root = fixture();
    scaffoldSetting(root, {
      ...(PROOF_SETTINGS[1] as (typeof PROOF_SETTINGS)[number]),
      format: false,
    });
    expect(notReasons(read(root, "server/src/datasources/detail.rs"))).toContain(
      "updates.devgen_proof_mode",
    );
    expect(read(root, "ui/src/features/settings/rows.tsx")).toContain(
      '{ value: "eager", label: t("admin.settings.updates.devgen_proof_mode.choice.eager") },',
    );
    expect(i18nCheck(root).errors).toEqual([]);
  });

  it("refuses settings of explicit-Save forms, texts that break the rules and a key twice", () => {
    const root = fixture();
    const base = PROOF_SETTINGS[0] as (typeof PROOF_SETTINGS)[number];
    expect(() => scaffoldSetting(root, { ...base, key: "mail.smtp_port", format: false })).toThrow(
      /explicit Save/,
    );
    expect(() =>
      scaffoldSetting(root, { ...base, descriptionDe: "Tage, die Sie warten.", format: false }),
    ).toThrow(/Sie/);
    expect(() =>
      scaffoldSetting(root, { ...base, key: "audit.retention_days", format: false }),
    ).toThrow(/already/);
    expect(() => scaffoldSetting(root, { ...base, default: "0", format: false })).toThrow(
      /not a whole number/,
    );
  });
});
