import { describe, expect, it } from "vitest";
import {
  asDocuments,
  asFrame,
  asGraph,
  type Fetch,
  frameRows,
  KalzitClient,
  KalzitError,
  type QueryResponse,
} from "../src/index.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake Kalzit: answers by "METHOD path" and records every call. */
function fake(answers: Record<string, (call: Call) => { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    calls.push(call);
    const path = new URL(url).pathname + new URL(url).search;
    const answer = answers[`${call.method} ${path}`];
    if (answer === undefined) {
      return new Response(
        JSON.stringify({ error: { code: "not_found", message: "no such route" } }),
        {
          status: 404,
        },
      );
    }
    const { status = 200, body } = answer(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const TOKEN = "kz_sa_0123456789abcdef0123456789abcdef01234567";
const ORG = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function client(fetch: Fetch) {
  return new KalzitClient({
    baseUrl: "https://kalzit.example.com/kalzit/",
    token: TOKEN,
    orgId: ORG,
    fetch,
  });
}

describe("KalzitClient", () => {
  it("signs every request with the service account token and keeps the sub-path", async () => {
    const f = fake({
      "GET /kalzit/api/me": () => ({
        body: { id: "u", email: "e", name: "n", isServerAdmin: false, orgs: [] },
      }),
    });
    const me = await client(f.fetch).me();
    expect(me.id).toBe("u");
    expect(f.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]?.url).toBe("https://kalzit.example.com/kalzit/api/me");
  });

  it("refuses anything but a service account token and an http address", () => {
    expect(() => new KalzitClient({ baseUrl: "https://k", token: "session", orgId: ORG })).toThrow(
      TypeError,
    );
    expect(() => new KalzitClient({ baseUrl: "ftp://k", token: TOKEN, orgId: ORG })).toThrow(
      TypeError,
    );
  });

  it("follows the cursor through every page of a list", async () => {
    const base = `/kalzit/api/orgs/${ORG}/dashboards`;
    const f = fake({
      [`GET ${base}?limit=200`]: () => ({
        body: { items: [{ id: "d1", title: "Eins" }], nextCursor: "c2" },
      }),
      [`GET ${base}?limit=200&cursor=c2`]: () => ({
        body: { items: [{ id: "d2", title: "Zwei" }], nextCursor: null },
      }),
    });
    const all = await client(f.fetch).dashboards.list();
    expect(all.map((d) => d.id)).toEqual(["d1", "d2"]);
  });

  it("sends queries with refIds and a time range, and keeps each result's shape", async () => {
    const answer: QueryResponse = {
      results: {
        A: {
          result: {
            shape: "frame",
            frame: { fields: [{ name: "n", type: "number", values: [1, 2] }] as never },
          },
        },
        B: { result: { shape: "documents", documents: { documents: [{ _id: 1 }] } as never } },
        C: { result: { shape: "graph", graph: { nodes: [], edges: [] } as never } },
        D: { error: { code: "query_rejected", message: "write", reason: "query.write_refused" } },
      },
    };
    const f = fake({ [`POST /kalzit/api/orgs/${ORG}/query`]: () => ({ body: answer }) });
    const c = client(f.fetch);
    const range = { from: new Date(0), to: 1000 };
    const r = await c.query(
      [
        { datasourceId: "pg", query: "SELECT 1" },
        { datasourceId: "mongo", query: [{ $match: {} }] },
        { datasourceId: "neo", query: "MATCH (n) RETURN n" },
        { datasourceId: "pg", query: "DELETE FROM t" },
      ],
      range,
    );
    const sent = f.calls[0]?.body as {
      queries: { refId: string }[];
      timeRange: unknown;
      variables: unknown;
    };
    expect(sent.queries.map((q) => q.refId)).toEqual(["A", "B", "C", "D"]);
    expect(sent.timeRange).toEqual({ from: 0, to: 1000 });
    expect(sent.variables).toEqual({});
    const a = r.results.A;
    if (a === undefined || "error" in a) throw new Error("A failed");
    expect(frameRows(asFrame(a.result))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(() => asGraph(a.result)).toThrow(TypeError);
    const b = r.results.B;
    if (b === undefined || "error" in b) throw new Error("B failed");
    expect(asDocuments(b.result).documents).toHaveLength(1);
    await expect(
      c.queryOne({ refId: "D", datasourceId: "pg", query: "DELETE" }, range),
    ).rejects.toMatchObject({
      reason: "query.write_refused",
    });
  });

  it("answers errors as KalzitError with code, reason and retry time", async () => {
    const f = fake({
      [`GET /kalzit/api/orgs/${ORG}/alerting/rules?state=firing`]: () => ({
        status: 429,
        body: { error: { code: "rate_limited", message: "slow down", retryAfterSecs: 30 } },
      }),
    });
    const e = await client(f.fetch)
      .alerts.rules({ state: "firing" })
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(KalzitError);
    expect((e as KalzitError).code).toBe("rate_limited");
    expect((e as KalzitError).retryAfterSecs).toBe(30);
  });

  it("names a network failure", async () => {
    const failing: Fetch = async () => {
      throw new Error("connection refused");
    };
    const e = await client(failing)
      .me()
      .catch((err: unknown) => err);
    expect((e as KalzitError).code).toBe("network");
    expect((e as KalzitError).status).toBe(0);
  });

  it("runs a panel's stored queries and pauses a rule", async () => {
    const f = fake({
      [`POST /kalzit/api/orgs/${ORG}/dashboards/d1/panels/p1/query`]: () => ({
        body: { results: {} },
      }),
      [`POST /kalzit/api/orgs/${ORG}/alerting/rules/r1/pause`]: () => ({
        body: { id: "r1", name: "CPU" },
      }),
    });
    const c = client(f.fetch);
    await c.dashboards.queryPanel("d1", "p1", { from: 0, to: 1 });
    expect(f.calls[0]?.body).toEqual({ cursors: {}, variables: {}, timeRange: { from: 0, to: 1 } });
    expect((await c.alerts.pause("r1")).name).toBe("CPU");
  });
});
