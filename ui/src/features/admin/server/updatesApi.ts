/**
 * The update routes (docs/api/updates.md), server administrators only. The status is checked on
 * its main fields, so a server that answers something else fails as `invalid_response`.
 */
import { expectShape, isRecord, request } from "../../../api/client";

export type Channel = "stable" | "preview";

export interface ReasonView {
  reason: string;
  params: Record<string, string>;
  message: string;
}

export interface Highlight {
  kind: "new" | "improved" | "fixed" | "security";
  text: string;
}

export type Job =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "downloading"; version: string; bytesDone: number; bytesTotal: number }
  | { phase: "applying"; version: string; step: "verify" | "backup" | "replace" }
  | { phase: "restarting"; version: string }
  | { phase: "failed"; action: string; error: ReasonView; at: number };

export interface Available {
  version: string;
  channel: Channel;
  size: number;
  sha256: string;
  notes: string;
  notesUrl: string | null;
  highlights: Highlight[];
  releasedAt: string | null;
  minimumVersion: string | null;
  keyId: string;
  staged: boolean;
}

export interface Staged {
  version: string;
  source: "online" | "offline";
  size: number;
  sha256: string;
  keyId: string;
  notes: string;
  notesUrl: string | null;
  highlights: Highlight[];
}

export interface Backup {
  file: string;
  size: number;
  version: string;
  at: number;
  kind: "switch" | "manual";
  by: string | null;
}

export interface HistoryEntry {
  version: string;
  from: string | null;
  at: number;
  kind: "update" | "rollback";
  outcome: "installed" | "rolledBack" | "aborted";
  reason: string | null;
  reasonCode: string | null;
  source: "online" | "offline" | "kept" | null;
  scheduled: boolean;
  actor: string | null;
  durationMs: number | null;
}

export interface RollbackTarget {
  version: string;
  keptAt: number;
  needsDatabaseRestore: boolean;
  restorePossible: boolean;
}

export interface UpdateStatus {
  installed: { version: string; platform: string; arch: string; since: number | null };
  channel: Channel;
  checkDaily: boolean;
  window: string;
  lastCheck: { at: number; latest: string | null; error: ReasonView | null } | null;
  available: Available | null;
  skipped: string | null;
  staged: Staged | null;
  job: Job;
  mode: { automatic: boolean; reason: string | null };
  database: "sqlite" | "postgres";
  schedule: { version: string; at: number; until: number | null } | null;
  trustedKeys: string[];
  preflight: {
    backupBytes: number | null;
    freeBytes: number | null;
    activeUsers: number;
    healthTimeoutSecs: number;
  };
  maxPackageBytes: number;
  backups: Backup[];
  history: HistoryEntry[];
  people: { id: string; name: string }[];
  rollbackTargets: RollbackTarget[];
}

function isStatus(value: unknown): value is UpdateStatus {
  return (
    isRecord(value) &&
    isRecord(value.installed) &&
    typeof value.installed.version === "string" &&
    (value.channel === "stable" || value.channel === "preview") &&
    typeof value.checkDaily === "boolean" &&
    isRecord(value.job) &&
    typeof value.job.phase === "string" &&
    isRecord(value.mode) &&
    isRecord(value.preflight) &&
    Array.isArray(value.backups) &&
    Array.isArray(value.history) &&
    Array.isArray(value.people) &&
    Array.isArray(value.rollbackTargets) &&
    Array.isArray(value.trustedKeys)
  );
}

const BASE = "/api/admin/updates";

async function status(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  return expectShape(await request(method, `${BASE}${path}`, body), isStatus, "update status");
}

export const updateKeys = { status: ["admin", "updates"] as const };

export const getUpdates = () => status("GET", "");
export const checkUpdates = () => status("POST", "/check");
export const downloadUpdate = (version: string) => status("POST", "/download", { version });
export const applyUpdate = (version: string, acknowledgeNoBackup = false) =>
  status("POST", "/apply", acknowledgeNoBackup ? { version, acknowledgeNoBackup } : { version });
export const scheduleUpdate = (
  version: string,
  at: number,
  until: number,
  acknowledgeNoBackup = false,
) =>
  status(
    "PUT",
    "/schedule",
    acknowledgeNoBackup ? { version, at, until, acknowledgeNoBackup } : { version, at, until },
  );
export const unscheduleUpdate = () => status("DELETE", "/schedule");
export const discardUpdate = () => status("DELETE", "/staged");
export const skipUpdate = (version: string) => status("POST", "/skip", { version });
export const backupNow = () => status("POST", "/backups");
export const rollbackTo = (version: string, restoreDatabase: boolean) =>
  status("POST", "/rollback", restoreDatabase ? { version, restoreDatabase } : { version });

/** Uploads an offline package (`.kalzit-update`). */
export function uploadPackage(file: File) {
  const form = new FormData();
  form.append("bundle", file, file.name);
  return status("POST", "/upload", form);
}

/** The download link of a backup. */
export function backupUrl(file: string): string {
  return `${BASE}/backups/${encodeURIComponent(file)}`;
}
