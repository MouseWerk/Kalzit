import { type FakeArea, json } from "../../../test/fakeServer";
import type { WirePlugin } from "./fakePlugins";

/**
 * The catalog routes of docs/api/plugins.md, "Catalog", for tests: the state with its settings,
 * the entries filtered by `q` and `kind`, refresh (its answer arranged per test), install (the
 * plugin it stores, or a refusal) and the three catalog settings through
 * `PATCH /admin/settings/{key}`. The server checks the index; here it is given.
 */

export interface WireCatalogItem {
  id: string;
  name: string;
  version: string;
  kind: string;
  description?: string;
  publisher?: string;
  keyId: string;
  keyName?: string;
  network: string[];
  size: number;
  sha256: string;
  urlHost: string;
  installedVersion?: string;
  pendingVersion?: string;
  revoked?: string;
  installedRevoked?: string;
  action: string;
}

type Refusal = { status: number; code: string; reason: string; params?: Record<string, string> };

export interface FakeCatalogState {
  enabled: boolean;
  url: string;
  refreshHours: number;
  versions: { enabled: number; url: number; refreshHours: number };
  /** `ready`, `expired`, `unreachable`, `not_loaded`; `off` and `unconfigured` follow the settings. */
  state: string;
  index?: Record<string, unknown>;
  lastError?: Record<string, unknown>;
  items: WireCatalogItem[];
  revoked: { id: string; versions: string; reason: string; installedVersion?: string }[];
  /** The answer of the next refresh: a refusal, or nothing (the state as it is). */
  refreshAnswer?: Refusal;
  /** The answer of the next install: the plugin it stores, or a refusal. */
  installAnswer: { plugin: WirePlugin } | Refusal;
  /** Installed plugins the install adds to (the plugin area's list). */
  installed?: WirePlugin[];
}

export const CATALOG_AT = Date.UTC(2026, 9, 28, 9, 12);

/** Fields to change; `undefined` leaves an optional field out. */
export type CatalogItemFields = {
  [Name in keyof WireCatalogItem]?: WireCatalogItem[Name] | undefined;
};

export function catalogItem(fields: CatalogItemFields = {}): WireCatalogItem {
  const item: Record<string, unknown> = {
    id: "dev.kalzit.bigquery",
    name: "BigQuery",
    version: "1.4.0",
    kind: "datasource",
    description: "SQL over datasets, partitions as time filters.",
    publisher: "Kalzit",
    keyId: "581c30a0d8384cfd",
    keyName: "Kalzit",
    network: ["*.googleapis.com:443"],
    size: 2_400_000,
    sha256: "3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708",
    urlHost: "plugins.kalzit.dev",
    action: "install",
    ...fields,
  };
  for (const [name, value] of Object.entries(item)) {
    if (value === undefined) delete item[name];
  }
  return item as unknown as WireCatalogItem;
}

function refuse(answer: Refusal) {
  return json(answer.status, {
    error: {
      code: answer.code,
      message: `server message for ${answer.reason}`,
      reason: answer.reason,
      ...(answer.params === undefined ? {} : { params: answer.params }),
    },
  });
}

function view(state: FakeCatalogState, search: URLSearchParams) {
  const settings = {
    enabled: { value: state.enabled, version: state.versions.enabled, editable: true },
    url: { value: state.url, version: state.versions.url, editable: true },
    refreshHours: {
      value: state.refreshHours,
      version: state.versions.refreshHours,
      editable: true,
    },
  };
  const phase = !state.enabled ? "off" : state.url === "" ? "unconfigured" : state.state;
  const listed = phase === "ready" || phase === "expired";
  const q = (search.get("q") ?? "").toLowerCase();
  const kind = search.get("kind") ?? "";
  const matching = listed
    ? state.items.filter((item) =>
        `${item.name} ${item.id} ${item.description ?? ""} ${item.publisher ?? ""}`
          .toLowerCase()
          .includes(q),
      )
    : [];
  return {
    state: phase,
    settings,
    ...(listed && state.index !== undefined ? { index: state.index, checkedAt: CATALOG_AT } : {}),
    ...(state.enabled && state.lastError !== undefined ? { lastError: state.lastError } : {}),
    items: matching.filter((item) => kind === "" || item.kind === kind),
    counts: {
      all: matching.length,
      datasource: matching.filter((item) => item.kind === "datasource").length,
      panel: matching.filter((item) => item.kind === "panel").length,
    },
    revoked: listed ? state.revoked : [],
  };
}

const SETTINGS: Record<string, "enabled" | "url" | "refreshHours"> = {
  "plugins.catalog_enabled": "enabled",
  "plugins.catalog_url": "url",
  "plugins.catalog_refresh_hours": "refreshHours",
};

/** `/api/admin/plugin-catalog*` and the catalog's settings. */
export function handleCatalogRoute(
  state: FakeCatalogState,
  path: string,
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  const [route = "", query = ""] = path.split("?");
  const settingKey = route.startsWith("/api/admin/settings/")
    ? decodeURIComponent(route.slice("/api/admin/settings/".length))
    : "";
  const name = SETTINGS[settingKey];
  if (name !== undefined && method === "PATCH") {
    if (body.version !== state.versions[name]) {
      return json(409, { error: { code: "version_conflict", message: "changed meanwhile" } });
    }
    if (
      name === "url" &&
      typeof body.value === "string" &&
      body.value !== "" &&
      !body.value.startsWith("https://")
    ) {
      return json(422, {
        error: {
          code: "validation",
          message: "plugins.catalog_url must be empty or an https:// address",
          field: "value",
        },
      });
    }
    if (name === "enabled") state.enabled = body.value === true;
    if (name === "url") state.url = String(body.value ?? "");
    if (name === "refreshHours") state.refreshHours = Number(body.value);
    state.versions[name] += 1;
    return json(200, {
      key: settingKey,
      scope: "server",
      value: body.value,
      default: name === "enabled" ? false : name === "url" ? "" : 24,
      source: "database",
      editable: true,
      version: state.versions[name],
      description: "",
      updatedAt: CATALOG_AT,
      updatedBy: "u1",
    });
  }
  if (!route.startsWith("/api/admin/plugin-catalog")) {
    return undefined;
  }
  const action = route.slice("/api/admin/plugin-catalog".length);
  if (action === "" && method === "GET") {
    return json(200, view(state, new URLSearchParams(query)));
  }
  if (action === "/refresh" && method === "POST") {
    if (!state.enabled) {
      return refuse({ status: 409, code: "conflict", reason: "catalog.disabled" });
    }
    const answer = state.refreshAnswer;
    if (answer !== undefined) {
      state.lastError = {
        reason: answer.reason,
        message: "",
        params: answer.params ?? {},
        at: CATALOG_AT,
      };
      return refuse(answer);
    }
    delete state.lastError;
    return json(200, view(state, new URLSearchParams()));
  }
  if (action === "/install" && method === "POST") {
    const answer = state.installAnswer;
    if (!("plugin" in answer)) {
      return refuse(answer);
    }
    const list = state.installed;
    if (list !== undefined) {
      const at = list.findIndex((plugin) => plugin.id === answer.plugin.id);
      if (at === -1) list.push(answer.plugin);
      else list[at] = answer.plugin;
    }
    return json(201, answer.plugin);
  }
  return undefined;
}

/** The catalog's state; it owns no organization routes. */
export function catalogFake(): FakeArea<FakeCatalogState> {
  const state: FakeCatalogState = {
    enabled: false,
    url: "",
    refreshHours: 24,
    versions: { enabled: 0, url: 0, refreshHours: 0 },
    state: "not_loaded",
    items: [],
    revoked: [],
    installAnswer: {
      status: 422,
      code: "validation",
      reason: "catalog.package_mismatch",
      params: { field: "sha256" },
    },
  };
  return { state, handle: () => undefined };
}
