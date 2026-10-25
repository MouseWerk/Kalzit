import { ApiError, expectShape, isRecord, request } from "../../api/client";
import { isSetting, type Setting } from "../admin/api";

/**
 * Calls of the settings page beyond the single setting (features/admin/api.ts has those):
 * export, import preview and batch (docs/api/settings-dashboards.md, "Export and import") and the
 * logo ("Appearance and brand").
 */

export type SettingsScope = { kind: "server" } | { kind: "org"; orgId: string };

function base(scope: SettingsScope): string {
  return scope.kind === "server"
    ? "/api/admin/settings"
    : `/api/orgs/${encodeURIComponent(scope.orgId)}/settings`;
}

export async function exportSettings(scope: SettingsScope): Promise<Record<string, unknown>> {
  return expectShape(await request("GET", `${base(scope)}/export`), isRecord, "settings export");
}

export const IMPORT_STATUSES = ["change", "same", "locked", "invalid", "unknown"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export interface ImportItem {
  key: string;
  status: ImportStatus;
  current: unknown;
  imported: unknown;
  version: number;
  /** Where the value in effect comes from; null for an unknown key. */
  source?: string | null;
  message?: string;
}

function isImportItem(value: unknown): value is ImportItem {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    (IMPORT_STATUSES as readonly unknown[]).includes(value.status) &&
    typeof value.version === "number"
  );
}

function itemsOf<T>(value: unknown, guard: (item: unknown) => item is T, what: string): T[] {
  const page = expectShape(value, isRecord, what);
  const items = Array.isArray(page.items) ? page.items : [];
  return items.map((item) => expectShape(item, guard, what));
}

export async function previewImport(
  scope: SettingsScope,
  document: unknown,
): Promise<ImportItem[]> {
  return itemsOf(
    await request("POST", `${base(scope)}/import/preview`, { document }),
    isImportItem,
    "import preview",
  );
}

/** A new value, or `reset` to delete the stored one so the default applies again. */
export type BatchChange =
  | { key: string; value: unknown; version: number }
  | { key: string; reset: true; version: number };

/**
 * The change that puts a setting back as it was: its old value, or a reset when it had none of
 * its own (`default`), so undo does not store a copy of the default.
 */
export function undoChange(
  key: string,
  previous: { value: unknown; source: string | null | undefined },
  version: number,
): BatchChange {
  return previous.source === "default"
    ? { key, reset: true, version }
    : { key, value: previous.value, version };
}

/** Removes a setting's stored value so its default applies again; answers it as it is now. */
export async function resetSetting(
  scope: SettingsScope,
  key: string,
  version: number,
): Promise<Setting> {
  const saved = (await applyBatch(scope, [{ key, reset: true, version }])).find(
    (setting) => setting.key === key,
  );
  if (saved === undefined) {
    throw new Error(`the settings batch did not answer ${key}`);
  }
  return saved;
}

/** Applies every change or none; answers the saved settings with their new versions. */
export async function applyBatch(scope: SettingsScope, changes: BatchChange[]): Promise<Setting[]> {
  return itemsOf(
    await request("POST", `${base(scope)}/batch`, { changes }),
    isSetting,
    "settings batch",
  );
}

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_LOGO_BYTES = 256 * 1024;

export async function uploadLogo(contentType: string, data: string): Promise<{ sha256: string }> {
  const answer = expectShape(
    await request("PUT", "/api/admin/branding/logo", { contentType, data }),
    isRecord,
    "logo",
  );
  return { sha256: typeof answer.sha256 === "string" ? answer.sha256 : "" };
}

export async function removeLogo(): Promise<void> {
  await request("DELETE", "/api/admin/branding/logo");
}

/** Undo of the last upload or removal: the logo before it comes back (or none). */
export async function restoreLogo(): Promise<void> {
  await request("POST", "/api/admin/branding/logo/restore", {});
}

/** The file's bytes as base64, for the logo upload. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * What the server says about itself (docs/api/shell.md, "About"): the version and build date for
 * everyone signed in, the rest for server administrators only.
 */
export interface About {
  version: string;
  buildDate: string;
  commit?: string;
  platform?: string;
  arch?: string;
  database?: "sqlite" | "postgres";
}

function isAbout(value: unknown): value is About {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    typeof value.buildDate === "string" &&
    (value.commit === undefined || typeof value.commit === "string") &&
    (value.platform === undefined || typeof value.platform === "string") &&
    (value.arch === undefined || typeof value.arch === "string") &&
    (value.database === undefined || value.database === "sqlite" || value.database === "postgres")
  );
}

export async function getAbout(): Promise<About> {
  return expectShape(await request("GET", "/api/about"), isAbout, "about");
}

/** One third-party package that ships with Kalzit. */
export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  source: "rust" | "npm";
}

function isLicenseEntry(value: unknown): value is LicenseEntry {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.license === "string" &&
    (value.source === "rust" || value.source === "npm")
  );
}

/** The list the build wrote into the bundle (`npm run licenses`); absent in a dev server. */
export async function getLicenses(): Promise<LicenseEntry[]> {
  const list = await request("GET", "/third-party-licenses.json");
  if (!Array.isArray(list) || !list.every(isLicenseEntry)) {
    throw new ApiError("invalid_response", 200, "unexpected licenses response");
  }
  return list;
}
