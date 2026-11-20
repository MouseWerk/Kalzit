/**
 * App plugins (docs/api/plugins.md, "App plugins"): the apps a member may use with their pages,
 * the address of a page's frame, the app's own storage, and the organization's settings per app
 * (blocked, least role).
 */
import { queryOptions } from "@tanstack/react-query";
import { isRecord, request } from "../../../api/client";
import { withBase } from "../../../lib/basePath";
import { monogram } from "../../../lib/monogram";

export interface AppPageInfo {
  id: string;
  /** The title by language; `en` is always there. */
  title: Record<string, string>;
}

export interface AppInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  /** The app message API version its pages speak. */
  api: number;
  /** What Kalzit's page does for the app's pages, with the member's rights. */
  capabilities: string[];
  pages: AppPageInfo[];
}

export const APP_CAPABILITIES = ["dashboards:read", "analyses:read", "analyses:run", "storage"];

export const APP_ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface AppSetting {
  id: string;
  name: string;
  blocked: boolean;
  /** The least role that may use the app in the organization. */
  minRole: AppRole;
  capabilities: string[];
  /** Bytes the app keeps in the organization. */
  usedBytes: number;
}

const base = (orgId: string, ...parts: string[]) =>
  `/api/orgs/${encodeURIComponent(orgId)}/${parts.map(encodeURIComponent).join("/")}`;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function parsePages(value: unknown): AppPageInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page): AppPageInfo[] => {
    if (!isRecord(page) || typeof page.id !== "string" || !isRecord(page.title)) return [];
    const title = Object.fromEntries(
      Object.entries(page.title).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    return [{ id: page.id, title }];
  });
}

function parseApp(value: unknown): AppInfo[] {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return [];
  }
  const app: AppInfo = {
    id: value.id,
    name: value.name,
    version: text(value.version) ?? "",
    api: typeof value.api === "number" ? value.api : 1,
    capabilities: strings(value.capabilities),
    pages: parsePages(value.pages),
  };
  const description = text(value.description);
  if (description !== undefined) app.description = description;
  const publisher = text(value.publisher);
  if (publisher !== undefined) app.publisher = publisher;
  return [app];
}

/** The apps the caller may use in the organization. */
export async function listApps(orgId: string, signal?: AbortSignal): Promise<AppInfo[]> {
  const value = await request("GET", base(orgId, "apps"), undefined, { signal });
  return isRecord(value) && Array.isArray(value.items) ? value.items.flatMap(parseApp) : [];
}

export const APPS_KEY = "apps";

export function appsQuery(orgId: string) {
  return queryOptions({
    queryKey: [APPS_KEY, orgId],
    queryFn: ({ signal }) => listApps(orgId, signal),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Two letters that stand for an app where it has no picture, by the rule of the plugin pages:
 * "Kapazitätsplanung" is "Ka", "Kapazitätsplanung Lager" is "KL". One rule, so an app carries the
 * same letters in the sidebar, in its bar and under Verwaltung > Plugins.
 */
export function appInitials(name: string): string {
  return monogram(name);
}

/** A page's title in the language shown, else in English, else its id. */
export function pageTitle(page: AppPageInfo, language: string): string {
  return page.title[language] ?? page.title.en ?? page.id;
}

/** Where a page's frame document is served (`text/html`, sandboxed policy). */
export function appFrameUrl(orgId: string, appId: string, pageId: string): string {
  return withBase(base(orgId, "apps", appId, "pages", pageId, "frame"));
}

function parseSetting(value: unknown): AppSetting[] {
  if (!isRecord(value) || typeof value.id !== "string") return [];
  const role = APP_ROLES.find((name) => name === value.minRole) ?? "viewer";
  return [
    {
      id: value.id,
      name: text(value.name) ?? value.id,
      blocked: value.blocked === true,
      minRole: role,
      capabilities: strings(value.capabilities),
      usedBytes: typeof value.usedBytes === "number" ? value.usedBytes : 0,
    },
  ];
}

export const appSettingsKey = (orgId: string) => [APPS_KEY, orgId, "settings"] as const;

export async function listAppSettings(orgId: string): Promise<AppSetting[]> {
  const value = await request("GET", base(orgId, "app-settings"));
  return isRecord(value) && Array.isArray(value.items) ? value.items.flatMap(parseSetting) : [];
}

export async function updateAppSetting(
  orgId: string,
  appId: string,
  patch: { minRole?: AppRole; blocked?: boolean },
): Promise<AppSetting | undefined> {
  return parseSetting(await request("PUT", base(orgId, "app-settings", appId), patch))[0];
}

/** The app's own storage: the routes behind the `storage.*` messages. */
export const appStorage = {
  list: (orgId: string, appId: string) => request("GET", base(orgId, "apps", appId, "storage")),
  get: (orgId: string, appId: string, key: string) =>
    request("GET", `${base(orgId, "apps", appId, "storage")}/${storageKey(key)}`),
  put: (orgId: string, appId: string, key: string, value: unknown) =>
    request("PUT", `${base(orgId, "apps", appId, "storage")}/${storageKey(key)}`, { value }),
  delete: (orgId: string, appId: string, key: string) =>
    request("DELETE", `${base(orgId, "apps", appId, "storage")}/${storageKey(key)}`),
};

/** A storage key as one part of the address (its `/` included). */
function storageKey(key: string): string {
  return encodeURIComponent(key);
}
