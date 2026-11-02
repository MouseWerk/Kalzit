/**
 * A small signed-in API client for seeding an instance, like ui/e2e/support/api.ts but on plain
 * fetch, so the toolkit needs no test runner. Requests carry no Origin header, like any API
 * client, so the server's cross-origin check lets them pass.
 */
export class KalzitClient {
  private cookies = new Map<string, string>();
  orgId = "";

  constructor(readonly baseUrl: string) {}

  static async signIn(baseUrl: string, email: string, password: string): Promise<KalzitClient> {
    const client = new KalzitClient(baseUrl);
    await client.request("POST", "/api/auth/login", { email, password });
    const me = await client.request<{ orgs: { id: string }[] }>("GET", "/api/me");
    client.orgId = me.orgs[0]?.id ?? "";
    if (client.orgId === "") {
      throw new Error(`${email} is in no organization`);
    }
    return client;
  }

  static async setup(
    baseUrl: string,
    input: { token: string; orgName: string; name: string; email: string; password: string },
  ): Promise<void> {
    await new KalzitClient(baseUrl).request("POST", "/api/setup", input);
  }

  org(path: string): string {
    return `/api/orgs/${this.orgId}${path}`;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(new URL(path, this.baseUrl), init);
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (pair !== undefined && eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  async createMember(
    name: string,
    role: string,
    password: string,
  ): Promise<{ id: string; email: string }> {
    const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@kalzit.test`;
    const user = await this.request<{ id: string }>("POST", "/api/admin/users", {
      name,
      email,
      password,
    });
    await this.request("POST", this.org("/members"), { email, role });
    return { id: user.id, email };
  }

  async createTeam(name: string, memberIds: readonly string[]): Promise<string> {
    const team = await this.request<{ id: string }>("POST", this.org("/teams"), { name });
    for (const userId of memberIds) {
      await this.request("PUT", this.org(`/teams/${team.id}/members/${userId}`), {});
    }
    return team.id;
  }

  async createSource(
    name: string,
    kind: string,
    settings: Record<string, unknown>,
    secrets: Record<string, string> = {},
  ): Promise<string> {
    const source = await this.request<{ id: string }>("POST", this.org("/datasources"), {
      name,
      kind,
      settings,
      secrets,
    });
    return source.id;
  }

  async createDashboard(model: Record<string, unknown>): Promise<string> {
    const dashboard = await this.request<{ id: string }>("POST", this.org("/dashboards"), {
      model,
    });
    return dashboard.id;
  }

  /** Sets a server setting with the version the server holds, as the settings page does. */
  async setServerSetting(key: string, value: unknown): Promise<void> {
    const list = await this.request<{ items: { key: string; version: number }[] }>(
      "GET",
      "/api/admin/settings",
    );
    const version = list.items.find((item) => item.key === key)?.version ?? 0;
    await this.request("PATCH", `/api/admin/settings/${key}`, { value, version });
  }

  async setPreferences(preferences: Record<string, string | null>): Promise<void> {
    await this.request("PATCH", "/api/me/preferences", preferences);
  }
}
