import {
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";

/**
 * The alerting routes of docs/api/alerting.md for tests: status, rules with instances, contact
 * points, silences, history and the per source opt-in, with the rights the server checks.
 * Alerting is off by default here, so other areas' tests see no alerting entry or requests
 * beyond the status. The server has its own tests; this is close enough for the UI.
 */

export interface FakeAlertingState {
  status: Record<string, unknown>;
  rules: Record<string, unknown>[];
  instances: Record<string, Record<string, unknown>[]>;
  contactPoints: Record<string, unknown>[];
  silences: Record<string, unknown>[];
  history: Record<string, unknown>[];
  /** Opted-in sources the caller may query, for the rule editor. */
  sources: { datasourceId: string; name: string; kind: string }[];
  /** `GET /datasources/{id}/alerting` by source id. */
  optIn: Record<string, { enabled: boolean; maxConcurrent: number | null }>;
  /** What `POST /rules/preview` answers; null answers 404, as a server without the route. */
  preview: Record<string, unknown> | null;
  /** Whether `GET /alerting/panels` exists (#288); false answers 404 as an older server. */
  panelsRoute: boolean;
  /** The bodies of rule saves, for checking what was sent. */
  saved: Record<string, unknown>[];
}

export const FAKE_STATUS_ON = {
  enabled: true,
  serverEnabled: true,
  orgEnabled: true,
  limits: {
    minIntervalSecs: 30,
    evaluationTimeoutSecs: 30,
    maxRulesPerOrg: 500,
    maxInstancesPerRule: 100,
    maxContactPointsPerRule: 5,
    maxSilencesPerOrg: 200,
    historyRetentionDays: 90,
  },
  mailConfigured: true,
  rules: 0,
  pausedRules: 0,
  instances: {},
};

function refusal(status: number, code: string, reason?: string, params?: Record<string, string>) {
  return json(status, {
    error: { code, message: `server message for ${reason ?? code}`, reason, params },
  });
}

let next = 1;
const id = (prefix: string) => `${prefix}-${next++}`;

export function alertingFake(_areas: FakeAreaStates): FakeArea<FakeAlertingState> {
  const state: FakeAlertingState = {
    status: { ...FAKE_STATUS_ON, enabled: false, orgEnabled: false },
    rules: [],
    instances: {},
    contactPoints: [],
    silences: [],
    history: [],
    sources: [],
    optIn: {},
    preview: null,
    panelsRoute: true,
    saved: [],
  };

  function contactView(point: Record<string, unknown>, details: boolean) {
    if (details) return { ...point, details: true };
    const recipients = Array.isArray(point.recipients) ? point.recipients : undefined;
    return {
      ...point,
      details: false,
      url: undefined,
      previousSecretUntil: undefined,
      recipients: recipients?.map((r) => `${String(r).slice(0, 1)}…@${String(r).split("@")[1]}`),
    };
  }

  return {
    state,
    handle: ({ method, route, body, permissions, search }: FakeRequest) => {
      const parts = route.split("/").slice(4);
      // A data source's opt-in lives under the data source.
      if (parts[0] === "datasources" && parts[2] === "alerting" && parts.length === 3) {
        const source = parts[1] ?? "";
        const optIn = state.optIn[source];
        if (optIn === undefined) return undefined;
        if (method === "PUT") {
          if (!permissions.has("datasources:write")) return refusal(403, "forbidden");
          state.optIn[source] = {
            enabled: body.enabled === true,
            maxConcurrent: typeof body.maxConcurrent === "number" ? body.maxConcurrent : null,
          };
        }
        const rules = state.rules.filter((rule) => rule.datasourceId === source);
        return json(200, {
          datasourceId: source,
          ...state.optIn[source],
          rules: rules.length,
          firingRules: rules.filter((rule) => rule.state === "firing").length,
        });
      }
      if (parts[0] !== "alerting") return undefined;
      if (!permissions.has("alerts:read")) return refusal(403, "forbidden");
      const [area = "", item, action] = parts.slice(1);
      if (area === "status" && method === "GET") {
        return json(200, { ...state.status, rules: state.rules.length });
      }
      if (area === "datasources" && method === "GET") {
        return json(200, { items: state.sources, nextCursor: null });
      }
      // The panel badges (#288): the rules of a dashboard's panels with their instances.
      if (area === "panels" && method === "GET" && state.panelsRoute) {
        const dashboardId = search.get("dashboardId");
        const byPanel = new Map<string, Record<string, unknown>[]>();
        for (const rule of state.rules) {
          if (rule.dashboardId !== dashboardId || typeof rule.panelId !== "string") continue;
          const instances = (state.instances[String(rule.id)] ?? []).filter(
            (instance) => instance.state !== "ok",
          );
          const list = byPanel.get(rule.panelId) ?? [];
          list.push({
            id: rule.id,
            name: rule.name,
            state: rule.state,
            paused: rule.paused,
            condition: rule.condition,
            instanceCounts: rule.instanceCounts,
            silenced:
              instances.length > 0 &&
              instances.every((instance) => (instance.silencedBy as unknown[]).length > 0),
            instances,
          });
          byPanel.set(rule.panelId, list);
        }
        return json(200, {
          items: [...byPanel].map(([panelId, rules]) => ({ panelId, rules })),
          nextCursor: null,
        });
      }
      if (area === "rules") {
        if (item === undefined && method === "GET") {
          const dashboardId = search.get("dashboardId");
          const items = state.rules.filter(
            (rule) => dashboardId === null || rule.dashboardId === dashboardId,
          );
          return json(200, { items, nextCursor: null });
        }
        if (item === "preview" && method === "POST") {
          if (!permissions.has("alerts:write")) return refusal(403, "forbidden");
          return state.preview === null ? refusal(404, "not_found") : json(200, state.preview);
        }
        if (!permissions.has("alerts:write") && method !== "GET") return refusal(403, "forbidden");
        if (item === undefined && method === "POST") {
          state.saved.push(body);
          const rule = {
            ...body,
            id: id("rule"),
            version: 1,
            paused: false,
            state: null,
            instanceCounts: {},
            queryHidden: false,
            createdAt: 0,
            updatedAt: 0,
            updatedByName: "Ada Lovelace",
            lastEvaluatedAt: null,
            skippedEvaluations: 0,
          };
          state.rules.push(rule);
          return json(201, rule);
        }
        const index = state.rules.findIndex((rule) => rule.id === item);
        const rule = state.rules[index];
        if (rule === undefined) return refusal(404, "not_found");
        if (action === undefined && method === "GET") {
          return json(200, { ...rule, instances: state.instances[String(rule.id)] ?? [] });
        }
        if (action === undefined && method === "PUT") {
          state.saved.push(body);
          if (body.version !== rule.version) {
            return json(409, {
              error: { code: "version_conflict", message: "older version" },
              current: rule,
            });
          }
          const { version: _version, ...rest } = body;
          const saved = { ...rule, ...rest, version: Number(rule.version) + 1 };
          state.rules[index] = saved;
          return json(200, saved);
        }
        if (action === undefined && method === "DELETE") {
          state.rules.splice(index, 1);
          return new Response(null, { status: 204 });
        }
        if ((action === "pause" || action === "resume") && method === "POST") {
          const saved = {
            ...rule,
            paused: action === "pause",
            // Pausing and resuming change the stored rule, as on the server (rules.rs).
            version: Number(rule.version) + 1,
            state: action === "pause" ? null : "ok",
          };
          state.rules[index] = saved;
          return json(200, saved);
        }
      }
      if (area === "contact-points") {
        const details = permissions.has("alerts:contacts");
        if (item === undefined && method === "GET") {
          return json(200, {
            items: state.contactPoints.map((point) => contactView(point, details)),
            nextCursor: null,
          });
        }
        if (!details) return refusal(403, "forbidden");
        if (item === undefined && method === "POST") {
          const point = {
            ...body,
            id: id("cp"),
            version: 1,
            rules: 0,
            lastDelivery: null,
            updatedAt: 0,
            host: typeof body.url === "string" ? new URL(body.url).host : undefined,
          };
          state.contactPoints.push(point);
          return json(201, {
            ...contactView(point, true),
            ...(body.kind === "webhook" ? { secret: "ab".repeat(32) } : {}),
          });
        }
        const index = state.contactPoints.findIndex((point) => point.id === item);
        const point = state.contactPoints[index];
        if (point === undefined) return refusal(404, "not_found");
        if (action === "test" && method === "POST") {
          return json(200, { ok: true, result: "ok", durationMs: 12 });
        }
        if (action === "secret" && method === "POST") {
          return json(200, { secret: "cd".repeat(32), previousSecretUntil: 1 });
        }
        if (action === undefined && method === "PUT") {
          const saved = { ...point, ...body, version: Number(point.version) + 1 };
          state.contactPoints[index] = saved;
          return json(200, contactView(saved, true));
        }
        if (action === undefined && method === "DELETE") {
          if (Number(point.rules) > 0) {
            return refusal(409, "conflict", "alerts.contact_point_in_use", {
              rules: String(point.rules),
            });
          }
          state.contactPoints.splice(index, 1);
          return new Response(null, { status: 204 });
        }
      }
      if (area === "silences") {
        if (item === undefined && method === "GET") {
          return json(200, { items: state.silences, nextCursor: null });
        }
        if (!permissions.has("alerts:write")) return refusal(403, "forbidden");
        if (item === "preview" && method === "POST") {
          return json(200, { items: [], nextCursor: null });
        }
        if (item === undefined && method === "POST") {
          const active = state.silences.filter((s) => s.status !== "expired").length;
          const max = (state.status.limits as { maxSilencesPerOrg: number }).maxSilencesPerOrg;
          if (active >= max) {
            return refusal(409, "conflict", "alerts.too_many_silences", { max: String(max) });
          }
          const silence = {
            ...body,
            id: id("silence"),
            startsAt: Date.now(),
            status: "active",
            createdBy: "u1",
            createdByName: "Ada Lovelace",
            createdAt: Date.now(),
            endedBy: null,
            endedByName: null,
            endedAt: null,
          };
          state.silences.push(silence);
          return json(201, silence);
        }
        const silence = state.silences.find((s) => s.id === item);
        if (silence !== undefined && action === "expire" && method === "POST") {
          silence.status = "expired";
          silence.endedAt = Date.now();
          return json(200, silence);
        }
      }
      if (area === "history" && method === "GET") {
        const ruleId = search.get("ruleId");
        return json(200, {
          items: state.history.filter((entry) => ruleId === null || entry.ruleId === ruleId),
          nextCursor: null,
        });
      }
      return refusal(404, "not_found");
    },
  };
}
