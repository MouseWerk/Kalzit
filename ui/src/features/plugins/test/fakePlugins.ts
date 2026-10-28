import {
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";

/**
 * The plugin routes of docs/api/plugins.md for tests: the list with the host switches, one
 * plugin with its manifest and "used in", install (the answer is arranged per test, since the
 * package is not read here), approve, enable, disable, restart, remove, logs, the trusted keys
 * with `plugin.key_in_use`, and the block list of an organization. Close enough to the
 * server's contract for the UI; the server has its own tests.
 */

export interface WirePlugin {
  id: string;
  name: string;
  version: string;
  kind: string;
  publisher?: string;
  shapes: string[];
  capabilities: string[];
  platforms: string[];
  signer: string;
  keyId?: string;
  trusted: boolean;
  approved: boolean;
  enabled: boolean;
  running: boolean;
  sandboxWarning?: string;
  permissions: Record<string, string>[];
  pending?: {
    version: string;
    signer: string;
    keyId?: string;
    permissions: Record<string, string>[];
    addedPermissions: Record<string, string>[];
  };
  process?: Record<string, unknown>;
  installedAt: number;
  updatedAt: number;
}

export interface WireKey {
  keyId: string;
  publicKey: string;
  name: string;
  addedAt: number;
  plugins: string[];
}

export interface FakePluginsState {
  plugins: WirePlugin[];
  keys: WireKey[];
  allowUnsigned: boolean;
  allowWithoutLandlock: boolean;
  landlockAvailable: boolean;
  platform: string;
  /** The answer of the next install: the plugin it stores, or a refusal. */
  installAnswer:
    | { plugin: WirePlugin }
    | { status: number; code: string; reason: string; params?: Record<string, string> };
  /** The answer of an install sent with `confirmPublisherChange=true`, if it differs. */
  confirmedInstallAnswer?: { plugin: WirePlugin };
  /** Data sources of each plugin's kind, by plugin id. */
  usedIn: Record<string, { id: string; name: string; orgId: string; orgName: string }[]>;
  logs: Record<string, { at: number; stream: string; text: string }[]>;
  /** Waiting updates signed by a key, by key id, for `plugin.key_in_use`. */
  pendingByKey: Record<string, string[]>;
  /** Plugins blocked in organization o1. */
  blocked: Set<string>;
}

export const AT = Date.UTC(2026, 9, 2, 9, 0);

/** Fields to change; `undefined` leaves an optional field out. */
export type PluginFields = { [Name in keyof WirePlugin]?: WirePlugin[Name] | undefined };

export function fakePlugin(fields: PluginFields = {}): WirePlugin {
  const plugin: Record<string, unknown> = {
    id: "nordlicht.snowflake",
    name: "Snowflake",
    version: "2.3.1",
    kind: "datasource",
    publisher: "Nordlicht Data GmbH",
    shapes: ["frame"],
    capabilities: [],
    platforms: ["linux-x64", "windows-x64"],
    signer: "publisher",
    keyId: "7f3a91c20d5be4a8",
    trusted: true,
    approved: true,
    enabled: true,
    running: true,
    permissions: [{ host: "acme.snowflakecomputing.com", port: "443", protocol: "tls" }],
    process: {
      state: "running",
      pid: 18244,
      startedAt: AT,
      starts: 1,
      failures: 0,
      sandbox: ["restricted_token", "low_integrity", "job_object"],
      sandboxMissing: ["network"],
    },
    installedAt: AT,
    updatedAt: AT,
    ...fields,
  };
  for (const [name, value] of Object.entries(plugin)) {
    if (value === undefined) delete plugin[name];
  }
  return plugin as unknown as WirePlugin;
}

function refusal(status: number, code: string, reason?: string, params?: Record<string, string>) {
  return json(status, {
    error: {
      code,
      message: `server message for ${reason ?? code}`,
      ...(reason === undefined ? {} : { reason }),
      ...(params === undefined ? {} : { params }),
    },
  });
}

function list(state: FakePluginsState) {
  return {
    items: state.plugins,
    allowUnsigned: state.allowUnsigned,
    allowWithoutLandlock: state.allowWithoutLandlock,
    landlockAvailable: state.landlockAvailable,
    platform: state.platform,
  };
}

/** `/api/admin/plugins*`, `/api/admin/plugin-keys*` and `/api/admin/plugin-host`. */
export function handlePluginAdminRoute(
  state: FakePluginsState,
  path: string,
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  const [route = "", query = ""] = path.split("?");
  if (route === "/api/admin/plugin-host") {
    if (method === "PATCH") {
      if (typeof body.allowUnsigned === "boolean") state.allowUnsigned = body.allowUnsigned;
      if (typeof body.allowWithoutLandlock === "boolean") {
        state.allowWithoutLandlock = body.allowWithoutLandlock;
      }
    }
    return json(200, {
      allowUnsigned: state.allowUnsigned,
      allowWithoutLandlock: state.allowWithoutLandlock,
      landlockAvailable: state.landlockAvailable,
    });
  }
  if (route.startsWith("/api/admin/plugin-keys")) {
    const keyId = decodeURIComponent(route.split("/")[4] ?? "");
    if (keyId === "" && method === "GET") {
      return json(200, { items: state.keys });
    }
    if (keyId === "" && method === "POST") {
      const publicKey = String(body.publicKey ?? "");
      if (state.keys.some((key) => key.publicKey === publicKey)) {
        return refusal(409, "conflict", "plugin.key_exists");
      }
      const key: WireKey = {
        keyId: `k${state.keys.length + 1}`.padEnd(16, "0"),
        publicKey,
        name: String(body.name ?? ""),
        addedAt: AT,
        plugins: [],
      };
      state.keys.push(key);
      return json(201, key);
    }
    if (method === "DELETE") {
      const key = state.keys.find((candidate) => candidate.keyId === keyId);
      if (key === undefined) {
        return refusal(404, "not_found", "plugin.key_unknown");
      }
      const pending = state.pendingByKey[keyId] ?? [];
      const confirm = new URLSearchParams(query).get("confirm") === "true";
      if ((key.plugins.length > 0 || pending.length > 0) && !confirm) {
        return refusal(409, "conflict", "plugin.key_in_use", {
          plugins: key.plugins.join(","),
          pending: pending.join(","),
        });
      }
      state.keys.splice(state.keys.indexOf(key), 1);
      for (const id of key.plugins) {
        const plugin = state.plugins.find((candidate) => candidate.id === id);
        if (plugin !== undefined) {
          plugin.trusted = false;
          plugin.running = false;
          delete plugin.process;
        }
      }
      return json(200, { stopped: key.plugins });
    }
    return undefined;
  }
  if (!route.startsWith("/api/admin/plugins")) {
    return undefined;
  }
  const [id = "", action] = route.split("/").slice(4).map(decodeURIComponent);
  if (id === "") {
    if (method === "GET") {
      return json(200, list(state));
    }
    if (method === "POST") {
      const confirmed = new URLSearchParams(query).get("confirmPublisherChange") === "true";
      const answer = (confirmed ? state.confirmedInstallAnswer : undefined) ?? state.installAnswer;
      if (!("plugin" in answer)) {
        return refusal(answer.status, answer.code, answer.reason, answer.params);
      }
      const index = state.plugins.findIndex((plugin) => plugin.id === answer.plugin.id);
      if (index === -1) {
        state.plugins.push(answer.plugin);
      } else {
        state.plugins[index] = answer.plugin;
      }
      return json(201, answer.plugin);
    }
    return undefined;
  }
  const plugin = state.plugins.find((candidate) => candidate.id === id);
  if (plugin === undefined) {
    return refusal(404, "not_found", "plugin.not_installed");
  }
  if (action === undefined && method === "GET") {
    return json(200, {
      ...plugin,
      manifest: `manifest = 1\nid = "${plugin.id}"\nname = "${plugin.name}"\nversion = "${plugin.version}"\n`,
      usedIn: state.usedIn[plugin.id] ?? [],
    });
  }
  if (action === undefined && method === "DELETE") {
    state.plugins.splice(state.plugins.indexOf(plugin), 1);
    return new Response(null, { status: 204 });
  }
  if (action === "approve" && method === "POST") {
    if (plugin.pending !== undefined && body.version === plugin.pending.version) {
      plugin.version = plugin.pending.version;
      plugin.permissions = plugin.pending.permissions;
      delete plugin.pending;
    } else if (!plugin.approved && body.version === plugin.version) {
      plugin.approved = true;
    } else {
      return refusal(409, "conflict", "plugin.nothing_to_approve");
    }
    return json(200, plugin);
  }
  if (action === "enable" && method === "POST") {
    if (!plugin.approved) {
      return refusal(409, "conflict", "plugin.not_approved");
    }
    plugin.enabled = true;
    plugin.running = true;
    plugin.process = { state: "idle", starts: 0, failures: 0, sandbox: [], sandboxMissing: [] };
    return json(200, plugin);
  }
  if (action === "disable" && method === "POST") {
    plugin.enabled = false;
    plugin.running = false;
    delete plugin.process;
    return json(200, plugin);
  }
  if (action === "restart" && method === "POST") {
    plugin.process = { state: "idle", starts: 0, failures: 0, sandbox: [], sandboxMissing: [] };
    return json(200, plugin);
  }
  if (action === "logs" && method === "GET") {
    return json(200, { lines: state.logs[plugin.id] ?? [], dropped: 0 });
  }
  return undefined;
}

/** The organization's block list (`/orgs/{orgId}/plugins`). */
export function pluginsFake(_areas: FakeAreaStates): FakeArea<FakePluginsState> {
  const state: FakePluginsState = {
    plugins: [],
    keys: [],
    allowUnsigned: false,
    allowWithoutLandlock: false,
    landlockAvailable: false,
    platform: "windows-x64",
    installAnswer: { status: 422, code: "validation", reason: "plugin.package_unreadable" },
    usedIn: {},
    logs: {},
    pendingByKey: {},
    blocked: new Set(),
  };
  return {
    state,
    handle: ({ method, route, permissions }: FakeRequest) => {
      const parts = route.split("/").slice(4);
      if (parts[0] !== "plugins") {
        return undefined;
      }
      if (!permissions.has("plugins:configure")) {
        return refusal(403, "forbidden");
      }
      if (parts.length === 1 && method === "GET") {
        return json(200, {
          items: state.plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            kind: plugin.kind,
            blocked: state.blocked.has(plugin.id),
          })),
        });
      }
      const id = decodeURIComponent(parts[1] ?? "");
      if (parts[2] === "block" && (method === "PUT" || method === "DELETE")) {
        if (method === "PUT") state.blocked.add(id);
        else state.blocked.delete(id);
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
  };
}
