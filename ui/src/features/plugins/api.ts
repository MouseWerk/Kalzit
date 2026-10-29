import { expectShape, isRecord, request } from "../../api/client";

/**
 * The plugin routes of docs/api/plugins.md: the installed plugins with their status, install
 * from a package file, approve, enable, disable, restart, remove, logs, the trusted publisher
 * keys, the host switches, and the block list of an organization.
 */

/** One network target of a manifest, as the administrator approves it. */
export interface PermissionLine {
  /** A target taken from a setting of the data source (`host`, `url`). */
  setting?: string;
  /** `host` or `url`: how the setting names the target. */
  form?: string;
  portSetting?: string;
  defaultPort?: string;
  /** A fixed target of the manifest. */
  host?: string;
  port?: string;
  /** `tcp`, `tls`, `http`, `https`. */
  protocol?: string;
}

export interface PendingUpdate {
  version: string;
  signer: string;
  keyId?: string;
  permissions: PermissionLine[];
  /** The targets the update adds; it runs only after they are approved. */
  addedPermissions: PermissionLine[];
}

export interface ProcessStatus {
  /** `idle` (not started yet), `running`, `waiting` (for its next start), `stopped`. */
  state: string;
  pid?: number;
  startedAt?: number;
  starts: number;
  /** Failures in a row. */
  failures: number;
  lastError?: { reason: string; message: string; at: number };
  /** While waiting: when the next start may happen. */
  retryAt?: number;
  sandbox: string[];
  sandboxMissing: string[];
  /** What an administrator should know: Kalzit's files with secrets other accounts may read, a
   * plugin running without Landlock. */
  warnings: { reason: string; params: Record<string, string>; message: string }[];
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  /** `datasource`; panels follow. */
  kind: string;
  description?: string;
  publisher?: string;
  license?: string;
  shapes: string[];
  capabilities: string[];
  platforms: string[];
  /** `kalzit`, `publisher` or `unsigned`. */
  signer: string;
  keyId?: string;
  /** The signing key is still trusted (always for unsigned plugins). */
  trusted: boolean;
  approved: boolean;
  enabled: boolean;
  /** Its kind is registered: approved, enabled, trusted and able to run here. */
  running: boolean;
  /** `landlock_missing` or `landlock_missing_allowed` on a Linux host without Landlock. */
  sandboxWarning?: string;
  /** Why it cannot run until removed and installed anew (`plugin.kind_changed`). */
  problem?: string;
  permissions: PermissionLine[];
  pending?: PendingUpdate;
  process?: ProcessStatus;
  installedAt: number;
  updatedAt: number;
}

export interface UsedIn {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
}

/** One plugin with what the list leaves out. */
export interface PluginDetail extends Plugin {
  /** The manifest exactly as signed (TOML). */
  manifest: string;
  /** The data sources of its kind in every organization. */
  usedIn: UsedIn[];
}

export interface HostSwitches {
  allowUnsigned: boolean;
  allowWithoutLandlock: boolean;
  landlockAvailable: boolean;
}

export interface PluginList extends HostSwitches {
  items: Plugin[];
  /** This server's platform as manifests name it (`windows-x64`, `linux-x64`, `linux-arm64`). */
  platform?: string;
}

export interface LogLine {
  at: number;
  /** `stdout`, `stderr`, or `host` for the host's own notes. */
  stream: string;
  text: string;
}

export interface PluginLogs {
  lines: LogLine[];
  dropped: number;
}

export interface TrustedKey {
  keyId: string;
  /** Base64, as `kalzit-sign` prints keys. */
  publicKey: string;
  name: string;
  addedAt: number;
  /** The installed plugins signed with it. */
  plugins: string[];
  /** The administrator allowed it to sign the catalog index too. */
  maySignCatalog: boolean;
}

export interface OrgPlugin {
  id: string;
  name: string;
  version: string;
  kind: string;
  blocked: boolean;
}

const enc = encodeURIComponent;

export const pluginKeys = {
  all: ["plugins"] as const,
  list: ["plugins", "list"] as const,
  one: (id: string) => ["plugins", "one", id] as const,
  logs: (id: string) => ["plugins", "logs", id] as const,
  keys: ["plugins", "keys"] as const,
  org: (orgId: string) => ["plugins", "org", orgId] as const,
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function permissionLine(value: unknown): PermissionLine {
  const line: PermissionLine = {};
  if (!isRecord(value)) {
    return line;
  }
  for (const name of [
    "setting",
    "form",
    "portSetting",
    "defaultPort",
    "host",
    "port",
    "protocol",
  ] as const) {
    const field = value[name];
    if (typeof field === "string" || typeof field === "number") {
      line[name] = String(field);
    }
  }
  return line;
}

const lines = (value: unknown): PermissionLine[] =>
  Array.isArray(value) ? value.map(permissionLine) : [];

function processStatus(value: unknown): ProcessStatus | undefined {
  if (!isRecord(value) || typeof value.state !== "string") {
    return undefined;
  }
  const status: ProcessStatus = {
    state: value.state,
    starts: typeof value.starts === "number" ? value.starts : 0,
    failures: typeof value.failures === "number" ? value.failures : 0,
    sandbox: strings(value.sandbox),
    sandboxMissing: strings(value.sandboxMissing),
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter(isRecord).flatMap((w) =>
          typeof w.reason === "string"
            ? [
                {
                  reason: w.reason,
                  params: isRecord(w.params)
                    ? Object.fromEntries(
                        Object.entries(w.params).filter(
                          (e): e is [string, string] => typeof e[1] === "string",
                        ),
                      )
                    : {},
                  message: text(w.message) ?? "",
                },
              ]
            : [],
        )
      : [],
  };
  if (typeof value.pid === "number") status.pid = value.pid;
  if (typeof value.startedAt === "number") status.startedAt = value.startedAt;
  if (typeof value.retryAt === "number") status.retryAt = value.retryAt;
  const last = value.lastError;
  if (isRecord(last) && typeof last.reason === "string") {
    status.lastError = {
      reason: last.reason,
      message: text(last.message) ?? "",
      at: typeof last.at === "number" ? last.at : 0,
    };
  }
  return status;
}

function isPluginShape(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.signer === "string" &&
    typeof value.approved === "boolean" &&
    typeof value.enabled === "boolean"
  );
}

export function parsePlugin(value: unknown): Plugin {
  const raw = expectShape(value, isPluginShape, "plugin");
  const plugin: Plugin = {
    id: raw.id as string,
    name: raw.name as string,
    version: raw.version as string,
    kind: text(raw.kind) ?? "datasource",
    shapes: strings(raw.shapes),
    capabilities: strings(raw.capabilities),
    platforms: strings(raw.platforms),
    signer: raw.signer as string,
    trusted: raw.trusted !== false,
    approved: raw.approved as boolean,
    enabled: raw.enabled as boolean,
    running: raw.running === true,
    permissions: lines(raw.permissions),
    installedAt: typeof raw.installedAt === "number" ? raw.installedAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
  for (const name of [
    "description",
    "publisher",
    "license",
    "keyId",
    "sandboxWarning",
    "problem",
  ] as const) {
    const field = text(raw[name]);
    if (field !== undefined) plugin[name] = field;
  }
  const pending = raw.pending;
  if (isRecord(pending) && typeof pending.version === "string") {
    plugin.pending = {
      version: pending.version,
      signer: text(pending.signer) ?? "",
      permissions: lines(pending.permissions),
      addedPermissions: lines(pending.addedPermissions),
      ...(typeof pending.keyId === "string" ? { keyId: pending.keyId } : {}),
    };
  }
  const process = processStatus(raw.process);
  if (process !== undefined) plugin.process = process;
  return plugin;
}

function parseDetail(value: unknown): PluginDetail {
  const plugin = parsePlugin(value);
  const raw = value as Record<string, unknown>;
  const usedIn = Array.isArray(raw.usedIn)
    ? raw.usedIn.flatMap((item): UsedIn[] =>
        isRecord(item) && typeof item.id === "string"
          ? [
              {
                id: item.id,
                name: text(item.name) ?? item.id,
                orgId: text(item.orgId) ?? "",
                orgName: text(item.orgName) ?? "",
              },
            ]
          : [],
      )
    : [];
  return { ...plugin, manifest: text(raw.manifest) ?? "", usedIn };
}

function parseSwitches(value: unknown): HostSwitches {
  const raw = expectShape(value, isRecord, "plugin host");
  return {
    allowUnsigned: raw.allowUnsigned === true,
    allowWithoutLandlock: raw.allowWithoutLandlock === true,
    landlockAvailable: raw.landlockAvailable === true,
  };
}

export async function listPlugins(signal?: AbortSignal): Promise<PluginList> {
  const answer = await request("GET", "/api/admin/plugins", undefined, { signal });
  const raw = expectShape(answer, isRecord, "plugins");
  const items = Array.isArray(raw.items) ? raw.items.map(parsePlugin) : [];
  const list: PluginList = { items, ...parseSwitches(raw) };
  const platform = text(raw.platform);
  if (platform !== undefined) list.platform = platform;
  return list;
}

export async function getPlugin(id: string, signal?: AbortSignal): Promise<PluginDetail> {
  return parseDetail(await request("GET", `/api/admin/plugins/${enc(id)}`, undefined, { signal }));
}

/**
 * Uploads a package (a zip file); the server checks it and answers the installed plugin. With
 * `confirmPublisherChange` a removed plugin's id is installed without its signing key, which
 * clears the stored secrets of its data sources (`plugin.publisher_changed`).
 */
export async function installPlugin(file: Blob, confirmPublisherChange = false): Promise<Plugin> {
  const body = new Blob([file], { type: "application/zip" });
  const path = confirmPublisherChange
    ? "/api/admin/plugins?confirmPublisherChange=true"
    : "/api/admin/plugins";
  return parsePlugin(await request("POST", path, body));
}

export async function approvePlugin(id: string, version: string): Promise<Plugin> {
  return parsePlugin(await request("POST", `/api/admin/plugins/${enc(id)}/approve`, { version }));
}

export type PluginAction = "enable" | "disable" | "restart";

export async function pluginAction(id: string, action: PluginAction): Promise<Plugin> {
  return parsePlugin(await request("POST", `/api/admin/plugins/${enc(id)}/${action}`));
}

export async function removePlugin(id: string): Promise<void> {
  await request("DELETE", `/api/admin/plugins/${enc(id)}`);
}

export async function pluginLogs(id: string, signal?: AbortSignal): Promise<PluginLogs> {
  const answer = await request("GET", `/api/admin/plugins/${enc(id)}/logs`, undefined, { signal });
  const raw = expectShape(answer, isRecord, "plugin logs");
  const items = Array.isArray(raw.lines) ? raw.lines : [];
  return {
    lines: items.flatMap((line): LogLine[] =>
      isRecord(line) && typeof line.text === "string"
        ? [
            {
              at: typeof line.at === "number" ? line.at : 0,
              stream: text(line.stream) ?? "stdout",
              text: line.text,
            },
          ]
        : [],
    ),
    dropped: typeof raw.dropped === "number" ? raw.dropped : 0,
  };
}

function parseKey(value: unknown): TrustedKey {
  const raw = expectShape(
    value,
    (v): v is Record<string, unknown> => isRecord(v) && typeof v.keyId === "string",
    "plugin key",
  );
  return {
    keyId: raw.keyId as string,
    publicKey: text(raw.publicKey) ?? "",
    name: text(raw.name) ?? "",
    addedAt: typeof raw.addedAt === "number" ? raw.addedAt : 0,
    plugins: strings(raw.plugins),
    maySignCatalog: raw.maySignCatalog === true,
  };
}

/** Allows a trusted publisher key to sign the catalog index, or takes that back. */
export async function setKeyCatalog(keyId: string, maySignCatalog: boolean): Promise<TrustedKey> {
  return parseKey(
    await request("PUT", `/api/admin/plugin-keys/${enc(keyId)}/catalog`, { maySignCatalog }),
  );
}

export async function listKeys(signal?: AbortSignal): Promise<TrustedKey[]> {
  const answer = await request("GET", "/api/admin/plugin-keys", undefined, { signal });
  const raw = expectShape(answer, isRecord, "plugin keys");
  return Array.isArray(raw.items) ? raw.items.map(parseKey) : [];
}

export async function addKey(name: string, publicKey: string): Promise<TrustedKey> {
  return parseKey(await request("POST", "/api/admin/plugin-keys", { name, publicKey }));
}

/** Removes a key; without `confirm` a key in use answers `plugin.key_in_use`. */
export async function removeKey(keyId: string, confirm: boolean): Promise<string[]> {
  const answer = await request(
    "DELETE",
    `/api/admin/plugin-keys/${enc(keyId)}${confirm ? "?confirm=true" : ""}`,
  );
  return isRecord(answer) ? strings(answer.stopped) : [];
}

export async function patchHostSwitches(
  patch: Partial<Pick<HostSwitches, "allowUnsigned" | "allowWithoutLandlock">>,
): Promise<HostSwitches> {
  return parseSwitches(await request("PATCH", "/api/admin/plugin-host", patch));
}

export async function listOrgPlugins(orgId: string, signal?: AbortSignal): Promise<OrgPlugin[]> {
  const answer = await request("GET", `/api/orgs/${enc(orgId)}/plugins`, undefined, { signal });
  const raw = expectShape(answer, isRecord, "organization plugins");
  const items = Array.isArray(raw.items) ? raw.items : [];
  return items.flatMap((item): OrgPlugin[] =>
    isRecord(item) && typeof item.id === "string"
      ? [
          {
            id: item.id,
            name: text(item.name) ?? item.id,
            version: text(item.version) ?? "",
            kind: text(item.kind) ?? "datasource",
            blocked: item.blocked === true,
          },
        ]
      : [],
  );
}

export async function setOrgBlock(orgId: string, pluginId: string, blocked: boolean) {
  await request(
    blocked ? "PUT" : "DELETE",
    `/api/orgs/${enc(orgId)}/plugins/${enc(pluginId)}/block`,
  );
}
