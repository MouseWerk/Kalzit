import { queryOptions } from "@tanstack/react-query";
import { expectShape, isRecord, request } from "../../api/client";
import type {
  GrafanaImportRequest,
  ImportItem,
  ImportReport,
  Provisioned,
  ResourceKind,
} from "../../api/generated/shapes";

/*
 * Provisioning sets and the Grafana dashboard import (docs/api/provisioning.md). Sets are applied
 * with `kalzit provision`, never here: the UI lists what the files manage, unlocks one resource
 * in an emergency, and imports Grafana dashboards.
 */

export const PROVISIONING_KEY = "provisioning";

const enc = encodeURIComponent;

function orgPath(orgId: string, rest: string): string {
  return `/api/orgs/${enc(orgId)}${rest}`;
}

const KINDS: readonly string[] = ["datasource", "role", "dashboard", "alertRule"];

function isProvisioned(value: unknown): value is Provisioned {
  return (
    isRecord(value) &&
    typeof value.set === "string" &&
    typeof value.kind === "string" &&
    KINDS.includes(value.kind) &&
    typeof value.uid === "string" &&
    typeof value.resourceId === "string" &&
    typeof value.path === "string" &&
    typeof value.appliedAt === "number"
  );
}

async function listProvisioned(orgId: string, signal?: AbortSignal): Promise<Provisioned[]> {
  const page = expectShape(
    await request("GET", orgPath(orgId, "/provisioning/resources"), undefined, { signal }),
    isRecord,
    "provisioned resources",
  );
  const items = Array.isArray(page.items) ? page.items : [];
  return items.map((item) => expectShape(item, isProvisioned, "provisioned resources"));
}

/** Everything the organization's provisioning sets manage; needs `provisioning:read`. */
export function provisionedQuery(orgId: string) {
  return queryOptions({
    queryKey: [PROVISIONING_KEY, orgId, "resources"] as const,
    queryFn: ({ signal }) => listProvisioned(orgId, signal),
    staleTime: 30_000,
  });
}

/** The kind as the unlock route names it (`alert_rule`, not `alertRule`). */
function routeKind(kind: ResourceKind): string {
  return kind === "alertRule" ? "alert_rule" : kind;
}

/** Unlocks one managed resource until the set is applied again; audited. */
export async function unlockResource(
  orgId: string,
  kind: ResourceKind,
  uid: string,
): Promise<Provisioned> {
  return expectShape(
    await request(
      "POST",
      orgPath(orgId, `/provisioning/resources/${routeKind(kind)}/${enc(uid)}/unlock`),
      {},
    ),
    isProvisioned,
    "unlocked resource",
  );
}

const STATUSES: readonly string[] = ["converted", "approximated", "skipped"];

function isImportItem(value: unknown): value is ImportItem {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    STATUSES.includes(value.status) &&
    Array.isArray(value.notes)
  );
}

function isImportReport(value: unknown): value is ImportReport {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    Array.isArray(value.items) &&
    value.items.every(isImportItem) &&
    isRecord(value.counts)
  );
}

export interface GrafanaImportAnswer {
  report: ImportReport;
  /** The saved dashboard's id; null for a dry run. */
  dashboardId: string | null;
}

/** Converts a Grafana dashboard; with `dryRun` it only reports what would become of it. */
export async function importGrafana(
  orgId: string,
  input: GrafanaImportRequest,
): Promise<GrafanaImportAnswer> {
  const answer = expectShape(
    await request("POST", orgPath(orgId, "/dashboards/import/grafana"), input),
    isRecord,
    "grafana import",
  );
  const dashboard = isRecord(answer.dashboard) ? answer.dashboard : null;
  return {
    report: expectShape(answer.report, isImportReport, "grafana import"),
    dashboardId: dashboard !== null && typeof dashboard.id === "string" ? dashboard.id : null,
  };
}

export interface StoredImportReport {
  source: string;
  sourceVersion: number | null;
  report: ImportReport;
  createdAt: number;
  createdBy: string | null;
}

/** The report of the import that made a dashboard; `not_found` for one made another way. */
export function importReportQuery(orgId: string, dashboardId: string) {
  return queryOptions({
    queryKey: [PROVISIONING_KEY, orgId, "import-report", dashboardId] as const,
    queryFn: async ({ signal }): Promise<StoredImportReport> => {
      const answer = expectShape(
        await request(
          "GET",
          orgPath(orgId, `/dashboards/${enc(dashboardId)}/import-report`),
          undefined,
          { signal },
        ),
        isRecord,
        "import report",
      );
      return {
        source: typeof answer.source === "string" ? answer.source : "grafana",
        sourceVersion: typeof answer.sourceVersion === "number" ? answer.sourceVersion : null,
        report: expectShape(answer.report, isImportReport, "import report"),
        createdAt: typeof answer.createdAt === "number" ? answer.createdAt : 0,
        createdBy: typeof answer.createdBy === "string" ? answer.createdBy : null,
      };
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
