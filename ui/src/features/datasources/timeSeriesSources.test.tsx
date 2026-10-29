import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import type { LabelsSchema, SqlSchema } from "./api";
import { fluxCompletions, logqlCompletions } from "./editors/completion";
import { tokenizeFlux, tokenizeLogql } from "./editors/syntax";
import { kindFamily, kindLogos } from "./kindMarks";
import {
  emptyQuery,
  familyOf,
  hasQuery,
  influxQuery,
  parseInfluxQuery,
  parseLokiQuery,
  queryText,
} from "./queryKinds";
import { groupSettings } from "./settingSections";
import { FAKE_KINDS } from "./test/fakeDatasources";

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function open(path: string) {
  const server = installFakeServer({ signedIn: true, user: asRole("admin") });
  return { server, ...renderApp(path) };
}

async function fill(user: ReturnType<typeof renderApp>["user"], field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

const labelsOf = (result: ReturnType<typeof logqlCompletions>) =>
  result?.options.map((o) => o.label);

// Wire shapes of GET .../schema in docs/api/datasources.md.
const LOKI: LabelsSchema = {
  kind: "labels",
  labels: ["app", "level"],
  values: { app: ["api", "web"], level: ["error", "info"] },
};
const INFLUX: SqlSchema = {
  kind: "tables",
  tables: [
    {
      schema: "metriken",
      name: "cpu",
      columns: [
        { name: "usage", type: "float" },
        { name: "host", type: "tag" },
      ],
    },
  ],
};

describe("InfluxDB, Loki and ClickHouse query forms", () => {
  it("chooses the editor family and starts with the documented empty form", () => {
    expect(familyOf("clickhouse")).toBe("sql");
    expect(familyOf("influxdb")).toBe("influx");
    expect(familyOf("loki")).toBe("logql");
    expect(emptyQuery("clickhouse")).toEqual({ sql: "" });
    expect(emptyQuery("influxdb")).toEqual({ influxql: "" });
    expect(emptyQuery("loki")).toEqual({ logql: "" });
  });

  it("keeps one InfluxDB language per query and switches the text over", () => {
    expect(parseInfluxQuery({ flux: "from(bucket: v.bucket)" })).toEqual({
      language: "flux",
      text: "from(bucket: v.bucket)",
    });
    expect(parseInfluxQuery({})).toEqual({ language: "influxql", text: "" });
    expect(influxQuery("sql", "SELECT 1")).toEqual({ sql: "SELECT 1" });
    expect(queryText({ flux: "buckets()" })).toBe("buckets()");
    expect(hasQuery({ influxql: " " }, "influxdb")).toBe(false);
    expect(hasQuery({ influxql: "SHOW DATABASES" }, "influxdb")).toBe(true);
  });

  it("reads Loki's options and leaves the defaults out", () => {
    expect(
      parseLokiQuery({ logql: '{app="api"}', limit: 50, direction: "forward", extra: 1 }),
    ).toEqual({ logql: '{app="api"}', limit: 50, direction: "forward" });
    expect(parseLokiQuery({ logql: "x", limit: -3, direction: "up" })).toEqual({ logql: "x" });
    expect(queryText({ logql: '{app="api"}' })).toBe('{app="api"}');
    expect(hasQuery({ logql: "" }, "loki")).toBe(false);
  });

  it("completes Loki labels, their values, durations and functions", () => {
    expect(labelsOf(logqlCompletions("{a", 2, LOKI))).toEqual(["app"]);
    expect(labelsOf(logqlCompletions('{app="', 6, LOKI))).toEqual(["api", "web"]);
    expect(labelsOf(logqlCompletions('{app="api", level=~"e', 22, LOKI))).toEqual(["error"]);
    expect(labelsOf(logqlCompletions('rate({app="api"}[5', 18, LOKI))).toEqual(["5m"]);
    expect(labelsOf(logqlCompletions("count_o", 7, LOKI))).toEqual(["count_over_time"]);
    expect(labelsOf(logqlCompletions("$__ra", 5, LOKI))).toEqual(["$__rate_interval", "$__range"]);
    expect(logqlCompletions("", 0, LOKI)).toBeNull();
  });

  it("completes Flux functions, the time range macros and measurements in strings", () => {
    expect(labelsOf(fluxCompletions("aggregateW", 10, INFLUX))).toEqual(["aggregateWindow"]);
    expect(labelsOf(fluxCompletions("range(start: v.time", 19, INFLUX))).toEqual([
      "v.timeRangeStart",
      "v.timeRangeStop",
    ]);
    expect(labelsOf(fluxCompletions('r._measurement == "c', 20, INFLUX))).toEqual(["cpu"]);
    expect(labelsOf(fluxCompletions('r._field == "us', 16, INFLUX))).toEqual(["usage"]);
  });

  it("highlights LogQL and Flux", () => {
    const logql = tokenizeLogql('rate({app="api"} |= "x" [5m])');
    expect(logql.find((t) => t.text === "rate")?.kind).toBe("function");
    expect(logql.find((t) => t.text === '"api"')?.kind).toBe("string");
    expect(logql.find((t) => t.text === "5m")?.kind).toBe("duration");
    const flux = tokenizeFlux("from(bucket: v.bucket) |> range(start: -1h) // Kommentar");
    expect(flux.find((t) => t.text === "from")?.kind).toBe("function");
    expect(flux.find((t) => t.text === "v.bucket")?.kind).toBe("macro");
    expect(flux.find((t) => t.text === "-1h")?.kind).toBe("duration");
    expect(flux.at(-1)?.kind).toBe("comment");
  });

  it("shows InfluxDB and ClickHouse with their logos and Loki with the log glyph", () => {
    expect(kindLogos("influxdb")).toEqual(["influxdb"]);
    expect(kindLogos("clickhouse")).toEqual(["clickhouse"]);
    expect(kindLogos("loki")).toEqual([]);
    expect(kindFamily("loki")).toBe("search");
    expect(kindFamily("clickhouse")).toBe("sql");
  });

  it("puts the InfluxDB version and token where the form asks for the connection and sign-in", () => {
    const influx = FAKE_KINDS.find((k) => k.kind === "influxdb");
    const groups = groupSettings(influx?.settings ?? []);
    const section = (name: string) =>
      groups.find((g) => g.specs.some((s) => s.name === name))?.section;
    expect(section("version")).toBe("connection");
    expect(section("organization")).toBe("connection");
    expect(section("token")).toBe("auth");
    const loki = FAKE_KINDS.find((k) => k.kind === "loki");
    expect(
      groupSettings(loki?.settings ?? []).find((g) => g.specs.some((s) => s.name === "tenantId"))
        ?.section,
    ).toBe("connection");
  });
});

describe("InfluxDB, Loki and ClickHouse settings forms", () => {
  it("offers the InfluxDB fields and sends the token as a secret", async () => {
    const { server, user } = open("/data-sources/new?kind=influxdb");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Metriken");
    await fill(user, screen.getByRole("textbox", { name: "URL" }), "http://influx:8086");
    expect(screen.getByRole("combobox", { name: /InfluxDB version/ })).toBeTruthy();
    await fill(user, screen.getByRole("textbox", { name: /Organization \(2\.x\)/ }), "kalzit");
    await fill(user, screen.getByRole("textbox", { name: /Database or bucket/ }), "metriken");
    const token = screen.getByLabelText(/API token/);
    expect(token.getAttribute("type")).toBe("password");
    await fill(user, token, "nur-lesen");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connected in \d+ ms/);
    expect(server.areas.datasources.tests[0]).toMatchObject({
      kind: "influxdb",
      settings: { url: "http://influx:8086", organization: "kalzit", database: "metriken" },
      secrets: { token: "nur-lesen" },
    });
  });

  it("offers the Loki fields with the tenant", async () => {
    const { user } = open("/data-sources/new");
    await user.click(await screen.findByRole("link", { name: "Loki" }));
    await screen.findByRole("textbox", { name: "Name" });
    expect(screen.getByRole("textbox", { name: "URL" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /Loki org ID \(X-Scope-OrgID\)/ })).toBeTruthy();
    expect(screen.getByLabelText(/Bearer token/).getAttribute("type")).toBe("password");
  });

  it("offers the ClickHouse fields with their defaults", async () => {
    const { user } = open("/data-sources/new");
    await user.click(await screen.findByRole("link", { name: "ClickHouse" }));
    await screen.findByRole("textbox", { name: "Name" });
    expect(screen.getByRole("textbox", { name: "URL" })).toBeTruthy();
    expect(screen.getByLabelText(/Password/).getAttribute("type")).toBe("password");
  });
});

describe("InfluxDB and Loki query editors", () => {
  it("switches the InfluxDB language and keeps the text", async () => {
    const { InfluxQueryEditor } = await import("./editors/TimeSeriesQueryEditors");
    installFakeServer({ signedIn: true, user: asRole("admin") });
    const onChange = vi.fn();
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InfluxQueryEditor
          orgId="o1"
          datasource={{ id: "ds-influx", kind: "influxdb" }}
          query={{ influxql: "SELECT usage FROM cpu" }}
          onChange={onChange}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "flux");
    expect(onChange).toHaveBeenLastCalledWith({ flux: "SELECT usage FROM cpu" });
  });

  it("stores Loki's line limit and order only when they differ from the defaults", async () => {
    const { LokiQueryEditor } = await import("./editors/TimeSeriesQueryEditors");
    installFakeServer({ signedIn: true, user: asRole("admin") });
    const onChange = vi.fn();
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LokiQueryEditor
          orgId="o1"
          datasource={{ id: "ds-loki", kind: "loki" }}
          query={{ logql: '{app="api"}' }}
          onChange={onChange}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Order" }), "forward");
    expect(onChange).toHaveBeenLastCalledWith({ logql: '{app="api"}', direction: "forward" });
    await user.click(screen.getByRole("textbox", { name: "Line limit (optional)" }));
    await user.paste("200");
    expect(onChange).toHaveBeenLastCalledWith({ logql: '{app="api"}', limit: 200 });
  });
});
