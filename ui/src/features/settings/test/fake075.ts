import type { Registration } from "../../../auth/registrationApi";
import type { FakeArea, FakeRequest } from "../../../test/fakeServer";
import type { AppInfo, AppSetting } from "../../plugins/apps/api";
import type { BackupRun, BackupsView, BackupTarget } from "../backupsApi";

/**
 * The routes of the 0.7.5 settings and app plugins for tests (docs/api/mail.md
 * "Self-registration", docs/api/backups.md, docs/api/plugins.md "App plugins"): they keep what
 * the tests arrange and answer the refusals the pages show; the server checks the rest itself.
 */
export interface Fake075State {
  registration: {
    available: boolean;
    requiresApproval: boolean;
    allowedDomains: string[];
    /** The addresses a link was asked for, in order. */
    started: string[];
    /** What confirming a link answers: a status, or the error it is refused with. */
    confirm:
      | "approved"
      | "pending"
      | { status: number; code: string; reason: string; field?: string };
    requests: Registration[];
    /** Every decision an admin took, as "approve <id> <role>" or "reject <id>". */
    decisions: string[];
  };
  backups: {
    view: BackupsView;
    runs: BackupRun[];
    /** The refusal of the next test or save; null passes. */
    refuse: { status: number; code: string; reason: string; field?: string } | null;
    /** Every body of the test and save routes, in order. */
    tests: unknown[];
    saves: unknown[];
  };
  apps: {
    list: AppInfo[];
    settings: AppSetting[];
    storage: Record<string, unknown>;
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refusal = (r: { status: number; code: string; reason: string; field?: string }) =>
  json(r.status, {
    error: {
      code: r.code,
      message: `server message for ${r.reason}`,
      reason: r.reason,
      ...(r.field === undefined ? {} : { field: r.field }),
    },
  });

export const BACKUP_T0 = Date.UTC(2026, 10, 14, 2, 30);

export function sampleRun(fields: Partial<BackupRun> = {}): BackupRun {
  return {
    id: "run-1",
    kind: "scheduled",
    targetKind: "s3",
    status: "succeeded",
    fileName: "kalzit-backup-20261114T023000.000Z.zip.enc",
    sizeBytes: 318_000_000,
    reason: null,
    detail: null,
    startedBy: null,
    startedAt: BACKUP_T0,
    finishedAt: BACKUP_T0 + 41_000,
    ...fields,
  };
}

export const S3_TARGET: BackupTarget = {
  kind: "s3",
  endpoint: "https://s3.eu-central.example",
  region: "eu-central-1",
  bucket: "kalzit-backups",
  prefix: "prod/",
  pathStyle: false,
  accessKeyId: "AKIAEXAMPLE7Q2M",
};

export const SAMPLE_APP: AppInfo = {
  id: "dev.nordlicht.capacity",
  name: "Capacity planning",
  version: "1.2.0",
  description: "Warehouse load and forecast.",
  publisher: "Nordlicht Data",
  api: 1,
  capabilities: ["dashboards:read", "storage"],
  pages: [
    { id: "overview", title: { en: "Overview", de: "Übersicht" } },
    { id: "forecast", title: { en: "Forecast", de: "Prognose" } },
  ],
};

export function fake075(): FakeArea<Fake075State> {
  const state: Fake075State = {
    registration: {
      available: false,
      requiresApproval: true,
      allowedDomains: [],
      started: [],
      confirm: "pending",
      requests: [],
      decisions: [],
    },
    backups: {
      view: {
        databaseIncluded: true,
        database: "sqlite",
        target: null,
        hasSecret: false,
        version: 1,
        schedule: {
          enabled: false,
          intervalHours: 24,
          keepCount: 14,
          encrypt: true,
          nextRunAt: null,
        },
        lastRun: null,
      },
      runs: [],
      refuse: null,
      tests: [],
      saves: [],
    },
    apps: { list: [], settings: [], storage: {} },
  };
  return {
    state,
    handle: ({ method, route, body }: FakeRequest) => {
      const parts = route.split("/").slice(4).map(decodeURIComponent);
      if (parts[0] === "apps" && parts.length === 1 && method === "GET") {
        const blocked = new Set(state.apps.settings.filter((s) => s.blocked).map((s) => s.id));
        return json(200, { items: state.apps.list.filter((app) => !blocked.has(app.id)) });
      }
      if (parts[0] === "apps" && parts[2] === "storage") {
        // A blocked app answers nothing, as on the server.
        if (state.apps.settings.some((s) => s.id === parts[1] && s.blocked)) {
          return refusal({ status: 404, code: "not_found", reason: "plugin.app_unavailable" });
        }
        const key = parts[3];
        if (key === undefined) {
          return json(200, {
            items: Object.keys(state.apps.storage).map((name) => ({ key: name })),
            usedBytes: 0,
            limitBytes: 52_428_800,
          });
        }
        if (method === "PUT") {
          state.apps.storage[key] = body.value;
          return new Response(null, { status: 204 });
        }
        if (method === "DELETE") {
          delete state.apps.storage[key];
          return new Response(null, { status: 204 });
        }
        return key in state.apps.storage
          ? json(200, { key, value: state.apps.storage[key], updatedAt: BACKUP_T0 })
          : refusal({ status: 404, code: "not_found", reason: "not_found" });
      }
      if (parts[0] === "app-settings" && parts.length === 1 && method === "GET") {
        return json(200, { items: state.apps.settings });
      }
      if (parts[0] === "app-settings" && method === "PUT") {
        const setting = state.apps.settings.find((s) => s.id === parts[1]);
        if (setting === undefined) {
          return refusal({ status: 404, code: "not_found", reason: "plugin.app_unavailable" });
        }
        Object.assign(setting, body);
        return json(200, setting);
      }
      return undefined;
    },
  };
}

/** The routes outside an organization: registration and backups. */
export function handle075Route(
  state: Fake075State,
  path: string,
  method: string,
  input: Record<string, unknown>,
): Response | undefined {
  const [route = ""] = path.split("?");
  const { registration, backups } = state;
  if (route === "/api/auth/registration" && method === "GET") {
    return json(200, {
      available: registration.available,
      requiresApproval: registration.available && registration.requiresApproval,
      allowedDomains: registration.available ? registration.allowedDomains : [],
    });
  }
  if (route === "/api/auth/registration" && method === "POST") {
    const email = String(input.email ?? "");
    const domain = email.split("@")[1] ?? "";
    if (!registration.allowedDomains.includes(domain)) {
      return refusal({
        status: 403,
        code: "forbidden",
        reason: "signup.domain_not_allowed",
        field: "email",
      });
    }
    registration.started.push(email);
    return json(202, { accepted: true });
  }
  if (route === "/api/auth/registration/confirm" && method === "POST") {
    return typeof registration.confirm === "string"
      ? json(200, { status: registration.confirm })
      : refusal(registration.confirm);
  }
  if (route === "/api/admin/registrations" && method === "GET") {
    return json(200, {
      items: registration.requests.filter((request) => request.status === "pending"),
      nextCursor: null,
    });
  }
  if (route.startsWith("/api/admin/registrations/") && method === "POST") {
    const [id = "", action = ""] = route.split("/").slice(4);
    const request = registration.requests.find((r) => r.id === id && r.status === "pending");
    if (request === undefined) {
      return refusal({ status: 404, code: "not_found", reason: "signup.not_pending" });
    }
    request.status = action === "approve" ? "approved" : "rejected";
    registration.decisions.push(
      action === "approve"
        ? `approve ${id} ${String(input.role)} into ${String(input.orgId)}`
        : `reject ${id}`,
    );
    return json(200, request);
  }
  if (route === "/api/admin/backups" && method === "GET") {
    return json(200, backups.view);
  }
  if (route === "/api/admin/backups/runs" && method === "GET") {
    return json(200, { items: backups.runs, nextCursor: null });
  }
  if (route === "/api/admin/backups/target/test" && method === "POST") {
    backups.tests.push(input);
    return backups.refuse === null ? json(200, { ok: true }) : refusal(backups.refuse);
  }
  if (route === "/api/admin/backups/target" && method === "PUT") {
    backups.saves.push(input);
    if (backups.refuse !== null) {
      return refusal(backups.refuse);
    }
    backups.view = {
      ...backups.view,
      target: (input.target ?? null) as BackupTarget | null,
      hasSecret: input.secretAccessKey !== undefined || backups.view.hasSecret,
      version: backups.view.version + 1,
    };
    return json(200, backups.view);
  }
  if (route === "/api/admin/backups/run" && method === "POST") {
    if (backups.view.target === null) {
      return refusal({ status: 409, code: "conflict", reason: "backup.no_target" });
    }
    const run = sampleRun({
      id: `run-${backups.runs.length + 2}`,
      kind: "manual",
      targetKind: backups.view.target.kind,
    });
    backups.runs.unshift(run);
    backups.view = { ...backups.view, lastRun: run };
    return json(200, run);
  }
  return undefined;
}
