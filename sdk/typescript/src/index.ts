/**
 * A typed client for Kalzit's public API (docs/guide/sdk-typescript.md), for Node and browsers.
 * It signs in with a service account token (`kz_sa_...`) as `Authorization: Bearer`, never with a
 * session cookie, and keeps every query result in its native shape: `frame`, `documents` or
 * `graph` (`QueryResult`). The wire types come from the server (`src/generated/shapes.ts`,
 * generated from `server/src/shapes.rs`; a server test fails when they are stale).
 */

import type {
  DocumentSet,
  ErrorBody,
  ErrorCode,
  Frame,
  GraphSet,
  Page,
  PanelQueryRequest,
  QueryItem,
  QueryOutcome,
  QueryRequest,
  QueryResponse,
  QueryResult,
  TimeRange,
} from "./generated/shapes.ts";

export type * from "./generated/shapes.ts";

/** What `fetch` the client uses: the platform's, or one given for tests and proxies. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Kalzit's address, with the sub-path when it runs under one: `https://kalzit.example.com`. */
  baseUrl: string;
  /** A service account token (`kz_sa_...`). */
  token: string;
  /** The organization of the token's service account; the methods below act in it. */
  orgId: string;
  fetch?: Fetch;
  /** Milliseconds before a request is given up (default 60 000). */
  timeoutMs?: number;
  /** Sent as `User-Agent` where the platform allows it. */
  userAgent?: string;
}

/** An error answer of Kalzit (`{"error": {...}}`), or a failure to reach it. */
export class KalzitError extends Error {
  /** The HTTP status; 0 when no answer came. */
  readonly status: number;
  /** The stable code (`not_found`, `forbidden`, `rate_limited`, ...), or `network`. */
  readonly code: ErrorCode | "network";
  /** The finer reason (`plugin.app_unavailable`, ...), when the server names one. */
  readonly reason: string | undefined;
  readonly params: Record<string, string>;
  readonly field: string | undefined;
  /** For `rate_limited`: seconds until another attempt can succeed. */
  readonly retryAfterSecs: number | undefined;
  readonly requestId: string | undefined;

  constructor(status: number, body: ErrorBody | undefined, message?: string) {
    super(message ?? body?.message ?? `Kalzit answered ${status}`);
    this.name = "KalzitError";
    this.status = status;
    this.code = body?.code ?? "network";
    this.reason = body?.reason;
    this.params = body?.params ?? {};
    this.field = body?.field;
    this.retryAfterSecs = body?.retryAfterSecs;
    this.requestId = body?.requestId;
  }
}

/** A dashboard as lists name it; the rest of its fields come as the server sends them. */
export interface DashboardSummary {
  id: string;
  title: string;
  [field: string]: unknown;
}

/** A dashboard with its model (panels, variables, time range). */
export interface Dashboard extends DashboardSummary {
  version: number;
  model: Record<string, unknown>;
}

export interface Datasource {
  id: string;
  name: string;
  kind: string;
  [field: string]: unknown;
}

/** An alert rule (docs/api/alerting.md, "Rules"). */
export interface AlertRule {
  id: string;
  name: string;
  /** `ok`, `pending`, `firing`, `no_data` or `error`. */
  state?: string;
  [field: string]: unknown;
}

export interface AlertInstance {
  fingerprint: string;
  state: string;
  labels?: Record<string, string>;
  [field: string]: unknown;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
  orgs: { id: string; name: string; role: string }[];
}

/** A query to run: the source's own query language, in its native result shape. */
export interface Query {
  refId?: string;
  datasourceId: string;
  /** SQL text, PromQL, a MongoDB pipeline, Cypher ...: what the source takes. */
  query: unknown;
  cursor?: string;
  limit?: number;
}

/** A time range as Unix milliseconds or `Date`s. */
export interface Range {
  from: number | Date;
  to: number | Date;
}

const ms = (t: number | Date) => (typeof t === "number" ? t : t.getTime());

function timeRange(range: Range): TimeRange {
  return { from: ms(range.from), to: ms(range.to) };
}

/** The result of a query outcome, or the outcome's error thrown as `KalzitError`. */
export function resultOf(outcome: QueryOutcome | undefined): QueryResult {
  if (outcome === undefined) {
    throw new KalzitError(0, undefined, "the answer holds no result for this query");
  }
  if ("error" in outcome) {
    throw new KalzitError(422, outcome.error);
  }
  return outcome.result;
}

/** The frame of a result; throws when the result is of another shape (no implicit conversion). */
export function asFrame(result: QueryResult): Frame {
  if (result.shape !== "frame") throw new TypeError(`the result is ${result.shape}, not frame`);
  return result.frame;
}

export function asDocuments(result: QueryResult): DocumentSet {
  if (result.shape !== "documents")
    throw new TypeError(`the result is ${result.shape}, not documents`);
  return result.documents;
}

export function asGraph(result: QueryResult): GraphSet {
  if (result.shape !== "graph") throw new TypeError(`the result is ${result.shape}, not graph`);
  return result.graph;
}

/** A frame's rows as objects, field name to value, for code that wants records. */
export function frameRows(frame: Frame): Record<string, unknown>[] {
  const fields = frame.fields as unknown as { name: string; values: unknown[] }[];
  const length = fields[0]?.values.length ?? 0;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < length; i++) {
    const row: Record<string, unknown> = {};
    for (const field of fields) row[field.name] = field.values[i];
    rows.push(row);
  }
  return rows;
}

export class KalzitClient {
  readonly orgId: string;
  private readonly base: string;
  private readonly token: string;
  private readonly fetcher: Fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string | undefined;

  constructor(options: ClientOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) {
      throw new TypeError("baseUrl must start with http:// or https://");
    }
    if (!options.token.startsWith("kz_sa_")) {
      throw new TypeError("token must be a service account token (kz_sa_...)");
    }
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.orgId = options.orgId;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.userAgent = options.userAgent;
  }

  /** Sends one request to `/api<path>` and answers its JSON (or `undefined` for `204`). */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (this.userAgent !== undefined) headers["user-agent"] = this.userAgent;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}/api${path}`, init);
    } catch (e) {
      throw new KalzitError(0, undefined, e instanceof Error ? e.message : String(e));
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const envelope = parsed as { error?: ErrorBody } | undefined;
      throw new KalzitError(res.status, envelope?.error);
    }
    return parsed as T;
  }

  private org(path: string): string {
    return `/orgs/${encodeURIComponent(this.orgId)}${path}`;
  }

  /** Every item of a list, page by page (`Page<T>`, `nextCursor`). */
  async *pages<T>(path: string, query: Record<string, string> = {}): AsyncGenerator<T> {
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ ...query, limit: "200" });
      if (cursor !== null) params.set("cursor", cursor);
      const page: Page<T> = await this.request("GET", `${path}?${params}`);
      yield* page.items;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  private async all<T>(path: string, query?: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this.pages<T>(path, query)) out.push(item);
    return out;
  }

  /** The service account itself, with its organization and role. */
  me(): Promise<Me> {
    return this.request("GET", "/me");
  }

  readonly dashboards = {
    /** The dashboards the token may read. */
    list: (): Promise<DashboardSummary[]> => this.all(this.org("/dashboards")),
    get: (dashboardId: string): Promise<Dashboard> =>
      this.request("GET", this.org(`/dashboards/${encodeURIComponent(dashboardId)}`)),
    /** Runs the stored queries of one panel, as reading the dashboard allows. */
    queryPanel: (
      dashboardId: string,
      panelId: string,
      range: Range,
      options: Partial<Omit<PanelQueryRequest, "timeRange">> = {},
    ): Promise<QueryResponse> =>
      this.request(
        "POST",
        this.org(
          `/dashboards/${encodeURIComponent(dashboardId)}/panels/${encodeURIComponent(panelId)}/query`,
        ),
        { cursors: {}, variables: {}, ...options, timeRange: timeRange(range) },
      ),
  };

  readonly datasources = {
    list: (): Promise<Datasource[]> => this.all(this.org("/datasources")),
    get: (datasourceId: string): Promise<Datasource> =>
      this.request("GET", this.org(`/datasources/${encodeURIComponent(datasourceId)}`)),
  };

  /**
   * Runs queries (needs `datasources:query`) and answers each by `refId`: a result in its native
   * shape or an error; one failing query does not fail the others.
   */
  query(
    queries: Query[],
    range: Range,
    options: {
      variables?: Record<string, unknown>;
      maxDataPoints?: number;
      refresh?: boolean;
    } = {},
  ): Promise<QueryResponse> {
    const items: QueryItem[] = queries.map((q, i) => {
      const item: QueryItem = {
        refId: q.refId ?? String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(i) : ""),
        datasourceId: q.datasourceId,
        query: q.query,
      };
      if (q.cursor !== undefined) item.cursor = q.cursor;
      if (q.limit !== undefined) item.limit = q.limit;
      return item;
    });
    const body: QueryRequest = {
      queries: items,
      timeRange: timeRange(range),
      variables: options.variables ?? {},
    };
    if (options.maxDataPoints !== undefined) body.maxDataPoints = options.maxDataPoints;
    if (options.refresh !== undefined) body.refresh = options.refresh;
    return this.request("POST", this.org("/query"), body);
  }

  /** One query, its result or its error thrown. */
  async queryOne(query: Query, range: Range): Promise<QueryResult> {
    const refId = query.refId ?? "A";
    const answer = await this.query([{ ...query, refId }], range);
    return resultOf(answer.results[refId]);
  }

  readonly alerts = {
    /** The organization's alert rules (`alerts:read`); `state` filters by state. */
    rules: async (
      filter: { state?: string; datasourceId?: string; dashboardId?: string } = {},
    ): Promise<AlertRule[]> => {
      // All rules come in one page.
      const params = new URLSearchParams(filter as Record<string, string>);
      const query = params.size > 0 ? `?${params}` : "";
      const page: Page<AlertRule> = await this.request("GET", this.org(`/alerting/rules${query}`));
      return page.items;
    },
    rule: (ruleId: string): Promise<AlertRule & { instances: AlertInstance[] }> =>
      this.request("GET", this.org(`/alerting/rules/${encodeURIComponent(ruleId)}`)),
    /** Pauses or resumes a rule (`alerts:write`). */
    pause: (ruleId: string): Promise<AlertRule> =>
      this.request("POST", this.org(`/alerting/rules/${encodeURIComponent(ruleId)}/pause`)),
    resume: (ruleId: string): Promise<AlertRule> =>
      this.request("POST", this.org(`/alerting/rules/${encodeURIComponent(ruleId)}/resume`)),
  };
}
