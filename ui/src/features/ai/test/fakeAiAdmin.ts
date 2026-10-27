import type { FakeArea, FakeAreaStates, FakeRequest, FakeServer } from "../../../test/fakeServer";
import type { FakeAdminState } from "../../admin/test/fakeAdmin";

/**
 * The AI configuration routes of docs/api/ai.md for tests: the status, providers of the server
 * and of organizations with their test, usage, what AI may read of each data source, and the
 * refusal to switch AI on without a tested provider. Close enough to the server's contract for
 * the UI's forms; the server has its own tests.
 */

export interface WireAiProvider {
  id: string;
  scope: "server" | "org";
  name: string;
  kind: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  tokenLimitField: string;
  apiKeySet: boolean;
  createdAt: number;
  updatedAt: number;
  lastTest?: { ok: boolean; reason?: string; at: number };
}

export interface WireAiUsage {
  day: string;
  orgId?: string;
  userId?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface FakeAiState {
  /** `GET /orgs/{orgId}/ai/status`; AI off by default, as on a new server. */
  status: Record<string, unknown>;
  serverProviders: WireAiProvider[];
  orgProviders: WireAiProvider[];
  /** `ai.allow_org_providers` as the provider routes see it. */
  allowOrgProviders: boolean;
  /** What a provider's connection test answers, by provider id; passing by default. */
  testAnswers: Record<string, Record<string, unknown>>;
  serverUsage: WireAiUsage[];
  orgUsage: WireAiUsage[];
  /** What AI may read of each data source, by data source id; closed by default. */
  access: Record<string, { readable: boolean; excludedFields: string[] }>;
  /** The AI calls asked for (explain, draft, summarize), with their path and body. */
  calls: { path: string; body: Record<string, unknown> }[];
  /**
   * What the next calls answer: the events of the stream (`aiEvents`), or a refusal before the
   * stream starts. A stream that never ends stays open until the request is aborted.
   */
  callAnswer:
    | { events: { event: string; data: unknown }[]; hang?: boolean }
    | {
        refusal: { status: number; code: string; reason?: string; params?: Record<string, string> };
      };
}

/** The events of a plain answer: what was sent, the text in two parts, the end. */
export function aiEvents(
  text: string,
  meta: Record<string, unknown> = {},
  done: Record<string, unknown> = {},
): { event: string; data: unknown }[] {
  const middle = Math.ceil(text.length / 2);
  return [
    {
      event: "meta",
      data: {
        provider: { name: "Lokal", kind: "openai", model: "modell-1", host: "llm.intern" },
        ...meta,
      },
    },
    { event: "text", data: { text: text.slice(0, middle) } },
    { event: "text", data: { text: text.slice(middle) } },
    { event: "done", data: { usage: { inputTokens: 40, outputTokens: 8 }, ...done } },
  ];
}

function eventStream(events: { event: string; data: unknown }[], hang: boolean): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const { event, data } of events) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      if (!hang) {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function answerCall(state: FakeAiState, path: string, body: Record<string, unknown>): Response {
  state.calls.push({ path, body });
  const answer = state.callAnswer;
  if ("refusal" in answer) {
    const { status, code, ...extra } = answer.refusal;
    return refusal(status, code, extra);
  }
  return eventStream(answer.events, answer.hang === true);
}

const T0 = Date.UTC(2026, 9, 20);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function refusal(
  status: number,
  code: string,
  extra: { field?: string; reason?: string; params?: Record<string, string> } = {},
  more: object = {},
): Response {
  return json(status, {
    error: { code, message: `server message for ${code}`, ...extra },
    ...more,
  });
}

export function fakeProvider(fields: Partial<WireAiProvider> = {}): WireAiProvider {
  return {
    id: "p1",
    scope: "server",
    name: "Local",
    kind: "openai",
    baseUrl: "http://llm.internal:11434/v1",
    model: "llama3.3:70b",
    isDefault: true,
    tokenLimitField: "auto",
    apiKeySet: false,
    createdAt: T0,
    updatedAt: T0,
    ...fields,
  };
}

function setting(key: string, scope: "server" | "org", value: unknown) {
  return {
    key,
    scope,
    value,
    default: value,
    source: "default" as const,
    editable: true,
    version: 0,
    description: `The setting ${key}`,
    updatedAt: null,
    updatedBy: null,
  };
}

/** Puts the AI settings of the registry into the fake administration, with their defaults. */
export function addAiSettings(admin: FakeAdminState): void {
  const server: [string, unknown][] = [
    ["ai.enabled", false],
    ["ai.allow_org_providers", true],
    ["ai.user_requests_per_day", 200],
    ["ai.user_tokens_per_day", 200_000],
    ["ai.org_tokens_per_month", 20_000_000],
    ["ai.max_rows_to_model", 200],
    ["ai.max_tool_calls", 10],
    ["ai.max_concurrent", 8],
    ["ai.max_concurrent_per_org", 4],
    ["ai.max_concurrent_per_user", 2],
    ["ai.request_timeout_secs", 120],
    ["ai.chat_retention_days", 30],
    ["ai.notice_text", ""],
  ];
  for (const [key, value] of server) {
    admin.serverSettings.push(setting(key, "server", value));
  }
  admin.orgSettings.push(setting("ai.org_enabled", "org", true));
  for (const key of [
    "ai.user_requests_per_day",
    "ai.user_tokens_per_day",
    "ai.org_tokens_per_month",
    "ai.chat_retention_days",
  ]) {
    admin.orgSettings.push(setting(key, "org", "inherit"));
  }
}

const tested = (provider: WireAiProvider | undefined) => provider?.lastTest?.ok === true;

function providerRoutes(
  state: FakeAiState,
  scope: "server" | "org",
  rest: string[],
  method: string,
  body: Record<string, unknown>,
  canWrite: boolean,
): Response {
  const list = scope === "server" ? state.serverProviders : state.orgProviders;
  const [id, action] = rest;
  if (id === undefined && method === "GET") {
    return json(200, { items: list, nextCursor: null });
  }
  if (!canWrite) {
    return refusal(403, "forbidden");
  }
  if (scope === "org" && !state.allowOrgProviders && method !== "DELETE") {
    return refusal(403, "forbidden", { reason: "ai.org_providers_not_allowed" });
  }
  const checkUrl = (value: unknown) =>
    typeof value === "string" && /^https?:\/\/[^\s?#@]+$/.test(value)
      ? undefined
      : refusal(422, "validation", { field: "baseUrl", reason: "ai.base_url_invalid" });
  const checkModel = (value: unknown) =>
    typeof value === "string" && value.trim() !== ""
      ? undefined
      : refusal(422, "validation", {
          field: "model",
          reason: "ai.model_invalid",
          params: { max: "200" },
        });
  if (id === undefined && method === "POST") {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return refusal(422, "validation", { field: "name" });
    }
    if (body.kind !== "openai" && body.kind !== "anthropic") {
      return refusal(422, "validation", {
        field: "kind",
        reason: "ai.kind_unknown",
        params: { kind: String(body.kind) },
      });
    }
    const bad = checkUrl(body.baseUrl) ?? checkModel(body.model);
    if (bad !== undefined) {
      return bad;
    }
    if (body.kind === "anthropic" && typeof body.apiKey !== "string") {
      return refusal(422, "validation", {
        field: "apiKey",
        reason: "ai.key_required",
        params: { kind: "anthropic" },
      });
    }
    const provider = fakeProvider({
      id: `p${list.length + 10}`,
      scope,
      name: body.name,
      kind: body.kind,
      baseUrl: String(body.baseUrl),
      model: String(body.model),
      isDefault: body.isDefault === true || list.length === 0,
      tokenLimitField: typeof body.tokenLimitField === "string" ? body.tokenLimitField : "auto",
      apiKeySet: typeof body.apiKey === "string",
      createdAt: T0 + list.length + 1,
      updatedAt: T0 + list.length + 1,
    });
    if (provider.isDefault) {
      for (const other of list) other.isDefault = false;
    }
    list.push(provider);
    return json(201, provider);
  }
  const provider = list.find((candidate) => candidate.id === id);
  if (provider === undefined) {
    return refusal(404, "not_found");
  }
  if (action === "test" && method === "POST") {
    const answer = state.testAnswers[provider.id] ?? { ok: true, latencyMs: 120, reply: "OK" };
    provider.lastTest = {
      ok: answer.ok === true,
      at: T0 + 100,
      ...(typeof answer.reason === "string" ? { reason: answer.reason } : {}),
    };
    return json(200, answer);
  }
  if (action === undefined && method === "PATCH") {
    if (body.expectedUpdatedAt !== provider.updatedAt) {
      return refusal(409, "version_conflict", {}, { current: provider });
    }
    if (body.baseUrl !== undefined) {
      const bad = checkUrl(body.baseUrl);
      if (bad !== undefined) return bad;
    }
    if (body.model !== undefined) {
      const bad = checkModel(body.model);
      if (bad !== undefined) return bad;
    }
    const moved = body.baseUrl !== undefined && body.baseUrl !== provider.baseUrl;
    if (moved && provider.apiKeySet && !("apiKey" in body)) {
      return refusal(422, "validation", {
        field: "apiKey",
        reason: "ai.key_resend_on_target_change",
      });
    }
    const connection = ["baseUrl", "model", "apiKey", "tokenLimitField"].some(
      (field) => field in body,
    );
    if (typeof body.name === "string") provider.name = body.name;
    if (typeof body.baseUrl === "string") provider.baseUrl = body.baseUrl;
    if (typeof body.model === "string") provider.model = body.model;
    if (typeof body.tokenLimitField === "string") provider.tokenLimitField = body.tokenLimitField;
    if ("apiKey" in body) provider.apiKeySet = typeof body.apiKey === "string";
    if (body.isDefault === true) {
      for (const other of list) other.isDefault = other === provider;
    }
    if (connection) {
      delete provider.lastTest;
    }
    provider.updatedAt += 1;
    return json(200, provider);
  }
  if (action === undefined && method === "DELETE") {
    list.splice(list.indexOf(provider), 1);
    const first = list[0];
    if (provider.isDefault && first !== undefined) {
      first.isDefault = true;
    }
    return new Response(null, { status: 204 });
  }
  return refusal(404, "not_found");
}

/** The server routes: `/api/admin/ai/*` and the switch `ai.enabled`. */
export function handleAiAdminRoute(
  state: FakeAiState,
  server: FakeServer,
  path: string,
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  const [route = "", query = ""] = path.split("?");
  if (!route.startsWith("/api/admin/")) {
    return undefined;
  }
  if (!server.state.signedIn || !server.state.user.isServerAdmin) {
    return undefined;
  }
  if (route === "/api/admin/settings/ai.enabled" && method === "PATCH" && body.value === true) {
    const fallback = state.serverProviders.find((provider) => provider.isDefault);
    if (!tested(fallback)) {
      return refusal(409, "conflict", {
        field: "value",
        reason: "ai.enable_needs_tested_provider",
      });
    }
    return undefined;
  }
  if (route === "/api/admin/ai/usage" && method === "GET") {
    const days = Number(new URLSearchParams(query).get("days") ?? "7");
    return json(200, { items: state.serverUsage.slice(0, days * 10), nextCursor: null });
  }
  const parts = route.split("/").slice(5);
  if (route.startsWith("/api/admin/ai/providers")) {
    return providerRoutes(state, "server", parts, method, body, true);
  }
  return undefined;
}

export function aiAdminFake(_areas: FakeAreaStates): FakeArea<FakeAiState> {
  const state: FakeAiState = {
    status: { enabled: false, usable: false, orgProvidersAllowed: true },
    serverProviders: [],
    orgProviders: [],
    allowOrgProviders: true,
    testAnswers: {},
    serverUsage: [],
    orgUsage: [],
    access: {},
    calls: [],
    callAnswer: { events: aiEvents("Die Abfrage summiert den Umsatz je Region.") },
  };
  return {
    state,
    handle: ({ method, route, body, permissions }: FakeRequest) => {
      const [, , , , ...parts] = route.split("/");
      if (parts[0] === "ai") {
        const rest = parts.slice(1);
        if (rest[0] === "status" && method === "GET") {
          return json(200, state.status);
        }
        if (rest[0] === "notice" && method === "POST") {
          state.status = { ...state.status, noticeAcknowledged: true };
          return new Response(null, { status: 204 });
        }
        if (
          method === "POST" &&
          (rest[0] === "explain" || rest[0] === "draft" || rest[0] === "summarize")
        ) {
          return answerCall(state, route, body);
        }
        if (rest[0] === "providers") {
          if (!permissions.has("settings:read")) {
            return refusal(403, "forbidden");
          }
          return providerRoutes(
            state,
            "org",
            rest.slice(1),
            method,
            body,
            permissions.has("settings:write"),
          );
        }
        if (rest[0] === "usage" && method === "GET") {
          return json(200, { items: state.orgUsage, nextCursor: null });
        }
        if (rest[0] === "datasources" && method === "GET") {
          const items = Object.entries(state.access)
            .filter(([, access]) => access.readable)
            .map(([datasourceId]) => ({ datasourceId }));
          return json(200, { items, nextCursor: null });
        }
        return undefined;
      }
      if (
        parts[0] === "dashboards" &&
        parts[2] === "panels" &&
        parts[4] === "ai" &&
        parts[5] === "summarize" &&
        method === "POST"
      ) {
        return answerCall(state, route, body);
      }
      if (parts[0] === "datasources" && parts[2] === "ai-access" && parts.length === 3) {
        const id = parts[1] ?? "";
        const current = state.access[id] ?? { readable: false, excludedFields: [] };
        if (method === "GET") {
          return json(200, { datasourceId: id, ...current });
        }
        if (method === "PUT") {
          if (!permissions.has("datasources:write")) {
            return refusal(403, "forbidden");
          }
          const fields = Array.isArray(body.excludedFields)
            ? body.excludedFields.map(String)
            : current.excludedFields;
          if (
            fields.length > 200 ||
            fields.some((field) => field.split(".").some((part) => part === ""))
          ) {
            return refusal(422, "validation", {
              field: "excludedFields",
              reason: "ai.excluded_fields_invalid",
              params: { max: "200" },
            });
          }
          state.access[id] = { readable: body.readable === true, excludedFields: fields };
          return json(200, { datasourceId: id, ...state.access[id] });
        }
      }
      if (
        parts[0] === "settings" &&
        parts[1] === "ai.org_enabled" &&
        method === "PATCH" &&
        body.value === true
      ) {
        const own = state.allowOrgProviders
          ? state.orgProviders.find((provider) => provider.isDefault)
          : undefined;
        const fallback = own ?? state.serverProviders.find((provider) => provider.isDefault);
        if (!tested(fallback)) {
          return refusal(409, "conflict", {
            field: "value",
            reason: "ai.enable_needs_tested_provider",
          });
        }
      }
      return undefined;
    },
  };
}
