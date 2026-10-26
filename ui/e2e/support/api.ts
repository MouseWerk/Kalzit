import { type APIRequestContext, type APIResponse, request } from "@playwright/test";

/** The owner the first-run test creates; every other test builds on this account. */
export const OWNER = {
  name: "Olga Owner",
  email: "owner@kalzit.test",
  password: "owner-password-e2e",
  orgName: "Sunstone Analytics",
} as const;

/**
 * The owner's German twin: the same name and role, with German as the account's language.
 * Language is a preference of the account (docs/api/shell.md), so the German runs sign in as this
 * account instead of switching the owner's language under the English runs beside them.
 */
export const OWNER_DE = {
  name: OWNER.name,
  email: "owner.de@kalzit.test",
  password: "owner-de-password-e2e",
} as const;

/**
 * The owner's high-contrast twin: the same name and role, with the contrast theme as the account's
 * theme, for the accessibility run in that theme (the theme is an account preference too).
 */
export const OWNER_CONTRAST = {
  name: OWNER.name,
  email: "owner.contrast@kalzit.test",
  password: "owner-contrast-password-e2e",
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

  /**
   * Creates `OWNER_DE` as a second owner of the organization and server admin, with German as its
   * language.
   */
  async createGermanOwner(): Promise<void> {
    await this.createTwin(OWNER_DE, { language: "de" }, "German");
  }

  /** Creates `OWNER_CONTRAST` like the German owner, with the contrast theme as its theme. */
  async createContrastOwner(): Promise<void> {
    await this.createTwin(OWNER_CONTRAST, { theme: "contrast" }, "contrast");
  }

  /** A second owner of the organization and server admin, with these preferences of its own. */
  private async createTwin(
    account: { name: string; email: string; password: string },
    preferences: Record<string, string>,
    what: string,
  ): Promise<void> {
    await json(
      await this.context.post("/api/admin/users", {
        data: {
          name: account.name,
          email: account.email,
          password: account.password,
          // Like the owner, so these runs reach the server administration too.
          isServerAdmin: true,
        },
      }),
      `create the ${what} owner`,
    );
    await json(
      await this.context.post(this.org("/members"), {
        data: { email: account.email, role: "owner" },
      }),
      `add the ${what} owner`,
    );
    const twin = await Api.signIn(account.email, account.password);
    try {
      await json(
        await twin.context.patch("/api/me/preferences", { data: preferences }),
        `the ${what} owner's preferences`,
      );
    } finally {
      await twin.dispose();
    }
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

  /** A CSV or JSON file source; the file must lie in the folder the e2e server allows. */
  async createFileSource(name: string, path: string): Promise<string> {
    const source = await json<{ id: string }>(
      await this.context.post(this.org("/datasources"), {
        data: { name, kind: "file", settings: { path }, secrets: {} },
      }),
      "create file source",
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

  /** Completes the first-run setup through the API, for runs that do not test that page. */
  static async setup(input: {
    token: string;
    orgName: string;
    name: string;
    email: string;
    password: string;
  }): Promise<void> {
    const context = await request.newContext({ baseURL: baseUrl() });
    try {
      await json(await context.post("/api/setup", { data: input }), "setup");
    } finally {
      await context.dispose();
    }
  }

  /** A team with these members (user ids). */
  async createTeam(name: string, memberIds: readonly string[]): Promise<string> {
    const team = await json<{ id: string }>(
      await this.context.post(this.org("/teams"), { data: { name } }),
      "create team",
    );
    for (const userId of memberIds) {
      await json(
        await this.context.put(this.org(`/teams/${team.id}/members/${userId}`), { data: {} }),
        "add team member",
      );
    }
    return team.id;
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
