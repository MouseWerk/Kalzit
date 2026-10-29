import { expectShape, isRecord, request } from "../../api/client";
import { type Plugin, parsePlugin } from "./api";

/**
 * The catalog routes of docs/api/plugins.md, "Catalog": its settings and state, the entries
 * (searched and filtered by kind), loading the index now, and installing an entry. Installing
 * answers the plugin exactly as an uploaded file does; the review that follows is the same.
 */

/** One catalog setting with what a change of it needs (`PATCH /admin/settings/{key}`). */
export interface CatalogSetting<T> {
  value: T;
  version: number;
  /** False when the environment or kalzit.toml sets it. */
  editable: boolean;
}

export interface CatalogSettings {
  enabled: CatalogSetting<boolean>;
  url: CatalogSetting<string>;
  refreshHours: CatalogSetting<number>;
}

export const CATALOG_SETTING_KEYS = {
  enabled: "plugins.catalog_enabled",
  url: "plugins.catalog_url",
  refreshHours: "plugins.catalog_refresh_hours",
} as const;

/** `off`, `unconfigured`, `not_loaded`, `unreachable`, `expired` or `ready`. */
export type CatalogState =
  | "off"
  | "unconfigured"
  | "not_loaded"
  | "unreachable"
  | "untrusted"
  | "expired"
  | "ready";

export interface CatalogIndexInfo {
  sequence: number;
  publishedAt: number;
  expiresAt: number;
  fetchedAt: number;
  keyId: string;
  /** `Kalzit` or the name of the trusted key; absent when the key is trusted no more. */
  signer?: string;
  host: string;
}

export interface CatalogFailure {
  reason: string;
  message: string;
  params?: Record<string, string>;
  at: number;
}

/** What the catalog offers for one plugin, and what is installed here. */
export type CatalogAction =
  | "install"
  | "update"
  | "installed"
  | "pending"
  | "untrusted"
  | "revoked";

export interface CatalogItem {
  id: string;
  name: string;
  version: string;
  kind: string;
  description?: string;
  publisher?: string;
  keyId: string;
  /** `Kalzit` or the trusted key's name; absent when nobody here trusts the key. */
  keyName?: string;
  network: string[];
  size: number;
  sha256: string;
  urlHost: string;
  installedVersion?: string;
  pendingVersion?: string;
  /** The offered version is withdrawn: why. */
  revoked?: string;
  /** The installed version is withdrawn: why. */
  installedRevoked?: string;
  action: CatalogAction;
}

export interface CatalogRevocation {
  id: string;
  versions: string;
  reason: string;
  installedVersion?: string;
}

export interface CatalogView {
  state: CatalogState;
  settings: CatalogSettings;
  index?: CatalogIndexInfo;
  lastError?: CatalogFailure;
  checkedAt?: number;
  items: CatalogItem[];
  counts: { all: number; datasource: number; panel: number };
  revoked: CatalogRevocation[];
}

export const catalogKeys = {
  all: ["plugins", "catalog"] as const,
  view: (query: string, kind: string) => ["plugins", "catalog", query, kind] as const,
};

const STATES: readonly CatalogState[] = [
  "off",
  "unconfigured",
  "not_loaded",
  "unreachable",
  "untrusted",
  "expired",
  "ready",
];
const ACTIONS: readonly CatalogAction[] = [
  "install",
  "update",
  "installed",
  "pending",
  "untrusted",
  "revoked",
];

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function params(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, field] of Object.entries(value)) {
    if (typeof field === "string" || typeof field === "number") out[name] = String(field);
  }
  return out;
}

function setting<T>(value: unknown, read: (raw: unknown) => T): CatalogSetting<T> {
  const raw = isRecord(value) ? value : {};
  return { value: read(raw.value), version: num(raw.version), editable: raw.editable !== false };
}

function item(value: unknown): CatalogItem[] {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.version !== "string") {
    return [];
  }
  const action = ACTIONS.find((candidate) => candidate === value.action) ?? "untrusted";
  const out: CatalogItem = {
    id: value.id,
    name: text(value.name) ?? value.id,
    version: value.version,
    kind: text(value.kind) ?? "datasource",
    keyId: text(value.keyId) ?? "",
    network: strings(value.network),
    size: num(value.size),
    sha256: text(value.sha256) ?? "",
    urlHost: text(value.urlHost) ?? "",
    action,
  };
  for (const name of [
    "description",
    "publisher",
    "keyName",
    "installedVersion",
    "pendingVersion",
    "revoked",
    "installedRevoked",
  ] as const) {
    const field = text(value[name]);
    if (field !== undefined) out[name] = field;
  }
  return [out];
}

export function parseCatalog(value: unknown): CatalogView {
  const raw = expectShape(value, isRecord, "plugin catalog");
  const settings = isRecord(raw.settings) ? raw.settings : {};
  const view: CatalogView = {
    state: STATES.find((candidate) => candidate === raw.state) ?? "off",
    settings: {
      enabled: setting(settings.enabled, (v) => v === true),
      url: setting(settings.url, (v) => text(v) ?? ""),
      refreshHours: setting(settings.refreshHours, (v) => (typeof v === "number" ? v : 24)),
    },
    items: Array.isArray(raw.items) ? raw.items.flatMap(item) : [],
    counts: {
      all: num(isRecord(raw.counts) ? raw.counts.all : 0),
      datasource: num(isRecord(raw.counts) ? raw.counts.datasource : 0),
      panel: num(isRecord(raw.counts) ? raw.counts.panel : 0),
    },
    revoked: Array.isArray(raw.revoked)
      ? raw.revoked.flatMap((r): CatalogRevocation[] =>
          isRecord(r) && typeof r.id === "string"
            ? [
                {
                  id: r.id,
                  versions: text(r.versions) ?? "",
                  reason: text(r.reason) ?? "",
                  ...(typeof r.installedVersion === "string"
                    ? { installedVersion: r.installedVersion }
                    : {}),
                },
              ]
            : [],
        )
      : [],
  };
  const index = raw.index;
  if (isRecord(index) && typeof index.sequence === "number") {
    view.index = {
      sequence: index.sequence,
      publishedAt: num(index.publishedAt),
      expiresAt: num(index.expiresAt),
      fetchedAt: num(index.fetchedAt),
      keyId: text(index.keyId) ?? "",
      host: text(index.host) ?? "",
      ...(typeof index.signer === "string" ? { signer: index.signer } : {}),
    };
  }
  const failure = raw.lastError;
  if (isRecord(failure) && typeof failure.reason === "string") {
    const p = params(failure.params);
    view.lastError = {
      reason: failure.reason,
      message: text(failure.message) ?? "",
      at: num(failure.at),
      ...(p === undefined ? {} : { params: p }),
    };
  }
  if (typeof raw.checkedAt === "number") view.checkedAt = raw.checkedAt;
  return view;
}

export async function getCatalog(
  query: string,
  kind: string,
  signal?: AbortSignal,
): Promise<CatalogView> {
  const search = new URLSearchParams();
  if (query.trim() !== "") search.set("q", query.trim());
  if (kind !== "") search.set("kind", kind);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return parseCatalog(
    await request("GET", `/api/admin/plugin-catalog${suffix}`, undefined, { signal }),
  );
}

/** Loads and checks the index now; a refusal names its reason (`catalog.*`). */
export async function refreshCatalog(acceptKeyChange = false): Promise<CatalogView> {
  const path = acceptKeyChange
    ? "/api/admin/plugin-catalog/refresh?acceptKeyChange=true"
    : "/api/admin/plugin-catalog/refresh";
  return parseCatalog(await request("POST", path));
}

/**
 * Downloads an entry's package and installs it like an uploaded file; answers the plugin, or a
 * refusal with the reason of the check that failed.
 */
export async function installFromCatalog(
  id: string,
  version: string,
  confirmPublisherChange = false,
): Promise<Plugin> {
  return parsePlugin(
    await request("POST", "/api/admin/plugin-catalog/install", {
      id,
      version,
      ...(confirmPublisherChange ? { confirmPublisherChange: true } : {}),
    }),
  );
}
