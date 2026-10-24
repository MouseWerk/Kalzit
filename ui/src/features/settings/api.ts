import { expectShape, isRecord, request } from "../../api/client";
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

export interface BatchChange {
  key: string;
  value: unknown;
  version: number;
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

/** The file's bytes as base64, for the logo upload. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
