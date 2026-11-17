/**
 * Scheduled backups and their target (docs/api/backups.md), server administrators only. The
 * schedule is server settings (instant, with undo); the target's fields depend on each other, so
 * it is saved in one step after a connection test.
 */
import { expectShape, isRecord, request } from "../../api/client";

export type BackupTarget =
  | { kind: "local"; path: string }
  | {
      kind: "s3";
      endpoint: string;
      region: string;
      bucket: string;
      prefix: string;
      pathStyle: boolean;
      accessKeyId: string;
    };

/** The fields the server names in `error.field`. */
export type BackupField =
  | "path"
  | "endpoint"
  | "region"
  | "bucket"
  | "prefix"
  | "accessKeyId"
  | "secretAccessKey";

export interface BackupRun {
  id: string;
  kind: "scheduled" | "manual";
  targetKind: "local" | "s3";
  status: "running" | "succeeded" | "failed";
  fileName: string | null;
  sizeBytes: number | null;
  reason: string | null;
  detail: string | null;
  startedBy: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface BackupsView {
  /** False with PostgreSQL: the schedule backs up the files, the database goes through pg_dump. */
  databaseIncluded: boolean;
  database: "sqlite" | "postgres";
  target: BackupTarget | null;
  hasSecret: boolean;
  version: number;
  schedule: {
    enabled: boolean;
    intervalHours: number;
    keepCount: number;
    encrypt: boolean;
    nextRunAt: number | null;
  };
  lastRun: BackupRun | null;
}

export const backupsKey = ["admin", "backups"] as const;
export const backupRunsKey = ["admin", "backups", "runs"] as const;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const optionalText = (value: unknown): string | null => (typeof value === "string" ? value : null);
const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

function target(value: unknown): BackupTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === "local") return { kind: "local", path: text(value.path) };
  if (value.kind !== "s3") return null;
  return {
    kind: "s3",
    endpoint: text(value.endpoint),
    region: text(value.region),
    bucket: text(value.bucket),
    prefix: text(value.prefix),
    pathStyle: value.pathStyle === true,
    accessKeyId: text(value.accessKeyId),
  };
}

function run(value: unknown): BackupRun | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.startedAt !== "number") {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind === "manual" ? "manual" : "scheduled",
    targetKind: value.targetKind === "s3" ? "s3" : "local",
    status: value.status === "succeeded" || value.status === "failed" ? value.status : "running",
    fileName: optionalText(value.fileName),
    sizeBytes: optionalNumber(value.sizeBytes),
    reason: optionalText(value.reason),
    detail: optionalText(value.detail),
    startedBy: optionalText(value.startedBy),
    startedAt: value.startedAt,
    finishedAt: optionalNumber(value.finishedAt),
  };
}

const isView = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && isRecord(value.schedule) && typeof value.version === "number";

function view(value: unknown): BackupsView {
  const raw = expectShape(value, isView, "backups");
  const schedule = raw.schedule as Record<string, unknown>;
  return {
    databaseIncluded: raw.databaseIncluded !== false,
    database: raw.database === "postgres" ? "postgres" : "sqlite",
    target: target(raw.target),
    hasSecret: raw.hasSecret === true,
    version: raw.version as number,
    schedule: {
      enabled: schedule.enabled === true,
      intervalHours: Number(schedule.intervalHours ?? 24),
      keepCount: Number(schedule.keepCount ?? 14),
      encrypt: schedule.encrypt !== false,
      nextRunAt: optionalNumber(schedule.nextRunAt),
    },
    lastRun: run(raw.lastRun),
  };
}

export async function getBackups(): Promise<BackupsView> {
  return view(await request("GET", "/api/admin/backups"));
}

/** Tests the form's values (or the saved target without `values`); refusals name their field. */
export async function testBackupTarget(
  values: BackupTarget | undefined,
  secretAccessKey: string | undefined,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (values !== undefined) body.target = values;
  if (secretAccessKey !== undefined) body.secretAccessKey = secretAccessKey;
  await request("POST", "/api/admin/backups/target/test", body);
}

/** Tests, then saves; `null` removes the target. */
export async function saveBackupTarget(
  values: BackupTarget | null,
  secretAccessKey: string | undefined,
  version: number,
): Promise<BackupsView> {
  const body: Record<string, unknown> = { target: values, version };
  if (secretAccessKey !== undefined) body.secretAccessKey = secretAccessKey;
  return view(await request("PUT", "/api/admin/backups/target", body));
}

/** Takes a backup now; answers the run, also when it failed. */
export async function runBackup(): Promise<BackupRun | null> {
  return run(await request("POST", "/api/admin/backups/run"));
}

export async function listBackupRuns(): Promise<BackupRun[]> {
  const value = await request("GET", "/api/admin/backups/runs?limit=20");
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return items.flatMap((item) => run(item) ?? []);
}
