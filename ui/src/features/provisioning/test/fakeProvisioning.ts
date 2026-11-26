import {
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";

/**
 * The provisioning routes of docs/api/provisioning.md the UI uses, for tests: the managed
 * resources, unlocking one, the Grafana import and its kept report. Sets are applied with the
 * command line, so tests arrange `resources` directly.
 */

export interface FakeProvisioningState {
  resources: Record<string, unknown>[];
  /** What a Grafana import answers as its report. */
  report: Record<string, unknown>;
  /** The id of the dashboard an import makes. */
  importedId: string;
  /** The kept reports by dashboard id (`GET /dashboards/{id}/import-report`). */
  reports: Record<string, Record<string, unknown>>;
  /** Grafana uids the server knows, with the dashboard each names (`GET /dashboards/by-uid/{uid}`). */
  uids: Record<string, string>;
  /** The bodies of import and unlock requests, for checking what was sent. */
  requests: { method: string; route: string; body: Record<string, unknown> }[];
}

/** A managed resource as `GET /provisioning/resources` lists it. */
export function fakeProvisioned(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    set: "kalzit-config",
    kind: "dashboard",
    uid: "main-board",
    resourceId: "d-main",
    name: "Main",
    path: "dashboards/vertrieb/main.yaml",
    checksum: "abc",
    appliedAt: Date.UTC(2026, 10, 14, 10, 42),
    appliedBy: "u1",
    unlockedAt: null,
    unlockedBy: null,
    drifted: false,
    missing: false,
    ...patch,
  };
}

export const FAKE_REPORT = {
  source: "grafana",
  sourceVersion: 39,
  title: "Lager",
  counts: { converted: 2, approximated: 1, skipped: 1 },
  items: [
    {
      kind: "dashboard",
      name: 'dashboard "Lager"',
      title: "Lager",
      status: "converted",
      notes: [],
    },
    {
      kind: "panel",
      name: 'panel 1 "Durchsatz"',
      title: "Durchsatz",
      status: "converted",
      notes: [],
    },
    {
      kind: "panel",
      name: 'panel 2 "Durchsatz (alt)"',
      title: "Durchsatz (alt)",
      status: "approximated",
      notes: [
        {
          code: "graph_panel",
          params: {},
          text: "the old graph panel became a time series; its own display options are not carried",
        },
      ],
    },
    {
      kind: "panel",
      name: 'panel 3 "Standorte"',
      title: "Standorte",
      status: "skipped",
      notes: [
        {
          code: "panel_type",
          params: { type: "grafana-worldmap-panel" },
          text: "Kalzit has no counterpart of the panel type grafana-worldmap-panel",
        },
      ],
    },
  ],
};

export function provisioningFake(_areas: FakeAreaStates): FakeArea<FakeProvisioningState> {
  const state: FakeProvisioningState = {
    resources: [],
    report: FAKE_REPORT,
    importedId: "d-imported",
    reports: {},
    uids: {},
    requests: [],
  };

  function handle(request: FakeRequest): Response | undefined {
    const { method, route, body } = request;
    const tail = route.replace(/^\/api\/orgs\/[^/]+/, "");
    const forbidden = () => json(403, { error: { code: "forbidden", message: "forbidden" } });
    if (tail === "/provisioning/resources" && method === "GET") {
      if (!request.permissions.has("provisioning:read")) return forbidden();
      return json(200, { items: state.resources, nextCursor: null });
    }
    const unlock = /^\/provisioning\/resources\/([^/]+)\/([^/]+)\/unlock$/.exec(tail);
    if (unlock !== null && method === "POST") {
      if (!request.permissions.has("provisioning:write")) return forbidden();
      state.requests.push({ method, route, body });
      const kind = unlock[1] === "alert_rule" ? "alertRule" : unlock[1];
      const record = state.resources.find(
        (item) => item.kind === kind && item.uid === decodeURIComponent(unlock[2] ?? ""),
      );
      if (record === undefined) {
        return json(404, { error: { code: "not_found", message: "not found" } });
      }
      record.unlockedAt = Date.now();
      record.unlockedBy = "u1";
      return json(200, record);
    }
    if (tail === "/dashboards/import/grafana" && method === "POST") {
      state.requests.push({ method, route, body });
      const dashboard = body.dashboard as Record<string, unknown> | null | undefined;
      if (dashboard === null || typeof dashboard !== "object" || dashboard.panels === undefined) {
        return json(422, {
          error: {
            code: "validation",
            message: "the JSON is not a dashboard",
            reason: "dashboards.import_unreadable",
          },
        });
      }
      if (body.dryRun === true) {
        return json(200, { report: state.report, model: {}, dashboard: null });
      }
      state.reports[state.importedId] = {
        source: "grafana",
        sourceVersion: 39,
        report: state.report,
        createdAt: Date.now(),
        createdBy: "u1",
      };
      return json(200, { report: state.report, model: {}, dashboard: { id: state.importedId } });
    }
    const byUid = /^\/dashboards\/by-uid\/([^/]+)$/.exec(tail);
    if (byUid !== null && method === "GET") {
      const id = state.uids[decodeURIComponent(byUid[1] ?? "")];
      return id === undefined
        ? json(404, { error: { code: "not_found", message: "not found" } })
        : json(200, { id });
    }
    const report = /^\/dashboards\/([^/]+)\/import-report$/.exec(tail);
    if (report !== null && method === "GET") {
      const stored = state.reports[report[1] ?? ""];
      return stored === undefined
        ? json(404, { error: { code: "not_found", message: "not found" } })
        : json(200, stored);
    }
    return undefined;
  }

  return { state, handle };
}
