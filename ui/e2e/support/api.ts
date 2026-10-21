import { type APIRequestContext, type APIResponse, request } from "@playwright/test";

/** The owner the first-run test creates; every other test builds on this account. */
export const OWNER = {
  name: "Olga Owner",
  email: "owner@kalzit.test",
  password: "owner-password-e2e",
  orgName: "Sunstone Analytics",
} as const;

export function baseUrl(): string {
  const url = process.env.KALZIT_E2E_URL;
  if (url === undefined || url === "") {
    throw new Error("KALZIT_E2E_URL is not set; run the suite through playwright.config.ts");
  }
  return url;
}

export function fixturesDir(): string {
  const dir = process.env.KALZIT_E2E_FIXTURES;
  if (dir === undefined || dir === "") {
    throw new Error("KALZIT_E2E_FIXTURES is not set; run the suite through playwright.config.ts");
  }
  return dir;
}

/** A name no other test uses, so tests can share the one server and run in parallel. */
export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function json<T>(response: APIResponse, what: string): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${what}: HTTP ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  password: string;
}

/**
 * A signed-in API client for arranging what a test needs (accounts, data sources, dashboards)
 * without clicking through pages another test already covers. Requests carry no Origin header,
 * like any API client, so the server's cross-origin check lets them pass.
 */
export class Api {
  private constructor(
    readonly context: APIRequestContext,
    readonly orgId: string,
  ) {}

  static async signIn(email: string, password: string): Promise<Api> {
    const context = await request.newContext({ baseURL: baseUrl() });
    await json(await context.post("/api/auth/login", { data: { email, password } }), "sign in");
    const me = await json<{ orgs: { id: string }[] }>(await context.get("/api/me"), "me");
    const orgId = me.orgs[0]?.id;
    if (orgId === undefined) {
      throw new Error(`${email} is in no organization`);
    }
    return new Api(context, orgId);
  }

  static owner(): Promise<Api> {
    return Api.signIn(OWNER.email, OWNER.password);
  }

  async dispose(): Promise<void> {
    await this.context.dispose();
  }

  private org(path: string): string {
    return `/api/orgs/${this.orgId}${path}`;
  }

  /** A new account (server admin route), added to the organization with this role. */
  async createMember(name: string, role: string): Promise<Member> {
    const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@kalzit.test`;
    const password = `pw-${Math.random().toString(36).slice(2)}-e2e`;
    const user = await json<{ id: string }>(
      await this.context.post("/api/admin/users", { data: { name, email, password } }),
      "create user",
    );
    await json(
      await this.context.post(this.org("/members"), { data: { email, role } }),
      "add member",
    );
    return { id: user.id, name, email, password };
  }

  async createSqliteSource(name: string, path: string): Promise<string> {
    const source = await json<{ id: string }>(
      await this.context.post(this.org("/datasources"), {
        data: { name, kind: "sqlite", settings: { path }, secrets: {} },
      }),
      "create data source",
    );
    return source.id;
  }

  async grantQuery(userId: string, datasourceId: string): Promise<void> {
    await json(
      await this.context.post(this.org("/grants"), {
        data: {
          subjectType: "user",
          subjectId: userId,
          resourceType: "datasource",
          resourceId: datasourceId,
          level: "query",
        },
      }),
      "grant query",
    );
  }

  async createDashboard(model: Record<string, unknown>): Promise<string> {
    const dashboard = await json<{ id: string }>(
      await this.context.post(this.org("/dashboards"), { data: { model } }),
      "create dashboard",
    );
    return dashboard.id;
  }
}

/** The fixture queries, written as a person would in the editor. */
export const SQL = {
  series:
    "SELECT ts AS time, amount FROM sales WHERE region = 'Nord' AND $__timeFilter(ts) ORDER BY ts",
  regions: "SELECT DISTINCT region FROM sales ORDER BY region",
  byRegion:
    "SELECT ts AS time, amount FROM sales WHERE region = $region AND $__timeFilter(ts) ORDER BY ts",
} as const;

/** A dashboard with a query variable `region` and one time series panel that uses it. */
export function regionDashboard(title: string, datasourceId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    title,
    timeRange: { from: "now-6h", to: "now" },
    variables: [
      { name: "region", label: "Region", type: "query", datasourceId, query: { sql: SQL.regions } },
    ],
    panels: [
      {
        id: "p1",
        type: "timeseries",
        title: "Sales",
        grid: { x: 0, y: 0, w: 12, h: 8 },
        targets: [{ refId: "A", datasourceId, query: { sql: SQL.byRegion } }],
      },
    ],
  };
}
