import { catalogs, type MessageKey, type Translate } from "../../i18n/i18n";
import { type Reason, reasonText } from "../datasources/reasons";
import type { PermissionLine, Plugin } from "./api";

/**
 * How a plugin is shown: its status in words and as a dot, the sandbox, the network targets it
 * may reach and the fingerprints of keys. Status is never color alone: the dot always has its
 * word next to it.
 */

/** The waits before the next start after the n-th failure (docs/api/plugins.md, "Processes"). */
export const BACKOFF_STEPS = 6;

/** The dot of `.ds-status`: green, amber, red or quiet. */
export type StatusTone = "connected" | "slow" | "unreachable" | "untested";

export interface PluginStatus {
  tone: StatusTone;
  label: MessageKey;
  /** A second line: why, or when it starts again. */
  detail?: string;
  /** Counted under "Problems". */
  problem: boolean;
}

/** The time until `at`, as m:ss (or h:mm:ss), never below zero. */
export function countdown(at: number, now: number): string {
  const total = Math.max(0, Math.ceil((at - now) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** The text of a plugin reason (`plugin.crashed`), from the data source reason catalog. */
export function pluginReasonText(t: Translate, reason: Reason): string {
  return reasonText(t, reason) ?? reason.fallback ?? reason.reason;
}

export function pluginStatus(t: Translate, plugin: Plugin, now: number): PluginStatus {
  if (!plugin.approved) {
    return { tone: "untested", label: "plugins.status.approval", problem: false };
  }
  if (!plugin.trusted) {
    return {
      tone: "unreachable",
      label: "plugins.status.untrusted",
      detail: pluginReasonText(t, { reason: "plugin.untrusted" }),
      problem: true,
    };
  }
  if (!plugin.enabled) {
    return { tone: "untested", label: "plugins.status.off", problem: false };
  }
  const process = plugin.process;
  if (!plugin.running || process === undefined) {
    const reason =
      plugin.sandboxWarning === "landlock_missing" ? "plugin.landlock_missing" : undefined;
    return {
      tone: "unreachable",
      label: "plugins.status.notLoaded",
      ...(reason === undefined ? {} : { detail: pluginReasonText(t, { reason }) }),
      problem: true,
    };
  }
  const error = process.lastError;
  const why =
    error === undefined
      ? undefined
      : pluginReasonText(t, { reason: error.reason, fallback: error.message });
  switch (process.state) {
    case "running":
      return { tone: "connected", label: "plugins.status.running", problem: false };
    case "waiting":
      return {
        tone: "unreachable",
        label: "plugins.status.crashed",
        detail: t("plugins.status.retry", {
          time: countdown(process.retryAt ?? now, now),
          attempt: Math.min(process.failures, BACKOFF_STEPS),
          count: BACKOFF_STEPS,
        }),
        problem: true,
      };
    case "stopped":
      return {
        tone: "unreachable",
        label: "plugins.status.stopped",
        detail: why ?? t("plugins.status.stoppedText"),
        problem: true,
      };
    default:
      return {
        tone: "untested",
        label: "plugins.status.idle",
        ...(why === undefined ? {} : { detail: why }),
        problem: false,
      };
  }
}

/** A key id (16 hex digits) in groups of four, as publishers print it. */
export function groupedKeyId(keyId: string): string {
  return (
    keyId
      .toUpperCase()
      .match(/.{1,4}/g)
      ?.join(" ") ?? keyId
  );
}

/** One network target in the UI's words: a fixed host, or the host a setting names. */
export function permissionText(t: Translate, line: PermissionLine): string {
  const protocol = line.protocol ?? "tcp";
  if (line.host !== undefined) {
    const target = line.port === undefined ? line.host : `${line.host}:${line.port}`;
    return t("plugins.permission.fixed", { target, protocol });
  }
  const setting = line.setting ?? "";
  if (line.portSetting !== undefined) {
    return t("plugins.permission.settingPort", {
      setting,
      port: line.portSetting,
      defaultPort: line.defaultPort ?? "",
      protocol,
    });
  }
  return t(line.form === "url" ? "plugins.permission.settingUrl" : "plugins.permission.setting", {
    setting,
    protocol,
  });
}

/** Whether two target lists hold the same line (the order of the fields does not matter). */
export function sameLine(a: PermissionLine, b: PermissionLine): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof PermissionLine>;
  return [...keys].every((key) => a[key] === b[key]);
}

/** The sandbox layers in the UI's words; unknown ones as the server names them. */
export function layerText(t: Translate, layer: string): string {
  const key = `plugins.layer.${layer}`;
  return Object.hasOwn(catalogs.en, key) ? t(key as MessageKey) : layer;
}
