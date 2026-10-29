/**
 * The Kalzit servers on this database (`GET /api/admin/instances`, docs/api/settings-dashboards.md,
 * "Instances"), server administrators only. Checked on its main fields, so a server that answers
 * something else fails as `invalid_response`.
 */
import { expectShape, isRecord, request } from "../../../api/client";

export interface Instance {
  id: string;
  host: string;
  version: string;
  address: string;
  startedAt: number;
  heartbeatAt: number;
  stoppedAt: number | null;
  alive: boolean;
  leader: boolean;
  /** The server that answered this request. */
  current: boolean;
}

export interface ClusterView {
  /** `single`: one server; `cluster`: several servers on one PostgreSQL database. */
  mode: "single" | "cluster";
  database: "sqlite" | "postgres";
  /** How changes reach this server: `notify`, `poll`, or `none` (SQLite). */
  transport: "notify" | "poll" | "none";
  leaderSince: number | null;
  leaderTerm: number;
  heartbeatSecs: number;
  leaseSecs: number;
  instances: Instance[];
}

function isView(value: unknown): value is ClusterView {
  return (
    isRecord(value) &&
    (value.mode === "single" || value.mode === "cluster") &&
    (value.database === "sqlite" || value.database === "postgres") &&
    typeof value.transport === "string" &&
    typeof value.heartbeatSecs === "number" &&
    Array.isArray(value.instances) &&
    value.instances.every(
      (i) => isRecord(i) && typeof i.id === "string" && typeof i.host === "string",
    )
  );
}

export const instanceKeys = { list: ["admin", "instances"] as const };

export async function getInstances(): Promise<ClusterView> {
  return expectShape(await request("GET", "/api/admin/instances"), isView, "instances");
}
