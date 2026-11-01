import { describe, expect, it } from "vitest";
import type { SettingSpec } from "./api";
import {
  MASK,
  parseConnectionString,
  supportsConnectionString,
  toConnectionString,
} from "./connectionString";
import { groupSettings, openAtFirst, pickerGroup, sectionOf, summarize } from "./settingSections";

const spec = (name: string, type: SettingSpec["type"], extra: Partial<SettingSpec> = {}) =>
  ({
    name,
    labelKey: `datasources.settings.${name}`,
    type,
    required: false,
    secret: false,
    target: false,
    ...extra,
  }) as SettingSpec;

const POSTGRES = [
  spec("host", "string", { required: true }),
  spec("port", "number", { default: 5432 }),
  spec("database", "string", { required: true }),
  spec("user", "string", { required: true }),
  spec("password", "string", { secret: true }),
  spec("sslMode", "select", {
    options: ["auto", "disable", "prefer", "require", "verify-ca", "verify-full"],
    default: "auto",
  }),
  spec("caCert", "text"),
  spec("maxRows", "number"),
];

const MYSQL = POSTGRES.map((s) =>
  s.name === "sslMode"
    ? spec("sslMode", "select", {
        options: ["auto", "disabled", "preferred", "required", "verify_ca", "verify_identity"],
        default: "auto",
      })
    : s.name === "port"
      ? spec("port", "number", { default: 3306 })
      : s,
);

const MONGO = [
  spec("hosts", "string", { required: true }),
  spec("port", "number", { default: 27017 }),
  spec("srv", "bool", { default: false }),
  spec("replicaSet", "string"),
  spec("database", "string", { required: true }),
  spec("user", "string"),
  spec("password", "string", { secret: true }),
  spec("authSource", "string"),
  spec("tls", "bool", { default: false }),
];

describe("connection strings", () => {
  it("are offered only where the fields are the parts of one", () => {
    expect(["postgres", "mysql", "mongodb"].every(supportsConnectionString)).toBe(true);
    expect(["mssql", "neo4j", "prometheus", "sqlite"].some(supportsConnectionString)).toBe(false);
  });

  it("fill the PostgreSQL fields and the password", () => {
    expect(
      parseConnectionString(
        "postgres",
        "postgresql://kalzit%40ro:p%2Fw@db.intern:6543/shop?sslmode=verify-full",
        POSTGRES,
      ),
    ).toEqual({
      ok: true,
      values: {
        user: "kalzit@ro",
        database: "shop",
        host: "db.intern",
        port: "6543",
        sslMode: "verify-full",
      },
      password: "p/w",
    });
  });

  it("leave a parameter the string omits as it is, so TLS is never weakened unasked", () => {
    const result = parseConnectionString("postgres", "postgres://db.intern/shop", POSTGRES);
    expect(result).toEqual({
      ok: true,
      values: { user: "", database: "shop", host: "db.intern", port: "5432" },
      password: undefined,
    });
  });

  it("end the login at the last @, so an unescaped @ in a password is read right", () => {
    expect(parseConnectionString("postgres", "postgres://u:p@ss@db.intern/shop", POSTGRES)).toEqual(
      {
        ok: true,
        values: { user: "u", database: "shop", host: "db.intern", port: "5432" },
        password: "p@ss",
      },
    );
    expect(
      parseConnectionString("mongodb", "mongodb://u:p@ss@a.intern,b.intern:27018/o", MONGO),
    ).toMatchObject({ ok: true, values: { hosts: "a.intern,b.intern:27018" }, password: "p@ss" });
  });

  it("check hosts, ports and the path", () => {
    expect(parseConnectionString("postgres", "postgres://u@a,b/d", POSTGRES)).toEqual({
      ok: false,
      error: "hostList",
      detail: "a,b",
    });
    expect(parseConnectionString("postgres", "postgres://h:70000/d", POSTGRES)).toEqual({
      ok: false,
      error: "port",
      detail: "70000",
    });
    expect(parseConnectionString("postgres", "postgres://h/d/extra", POSTGRES)).toEqual({
      ok: false,
      error: "path",
      detail: "/d/extra",
    });
    expect(parseConnectionString("postgres", "postgres://u:p@/d", POSTGRES)).toEqual({
      ok: false,
      error: "host",
    });
    expect(parseConnectionString("mongodb", "mongodb://a.intern,b x/o", MONGO)).toEqual({
      ok: false,
      error: "host",
      detail: "b x",
    });
    expect(parseConnectionString("mongodb", "mongodb://a:0/o", MONGO)).toEqual({
      ok: false,
      error: "port",
      detail: "0",
    });
  });

  it("split each parameter at its first = and name broken escapes", () => {
    expect(parseConnectionString("mongodb", "mongodb://h/o?replicaSet=a=b", MONGO)).toMatchObject({
      ok: true,
      values: { replicaSet: "a=b" },
    });
    expect(parseConnectionString("mongodb", "mongodb://h/o?replicaSet=%zz", MONGO)).toEqual({
      ok: false,
      error: "decode",
      detail: "replicaset",
    });
    expect(parseConnectionString("postgres", "postgres://u:%zz@h/d", POSTGRES)).toEqual({
      ok: false,
      error: "decode",
      detail: "password",
    });
  });

  it("read IPv6 hosts and MySQL's ssl-mode in any case", () => {
    expect(
      parseConnectionString("mysql", "mysql://u@[::1]:3307/erp?ssl-mode=VERIFY_IDENTITY", MYSQL),
    ).toMatchObject({
      ok: true,
      values: { host: "::1", port: "3307", sslMode: "verify_identity" },
    });
  });

  it("read MongoDB host lists, SRV and options", () => {
    expect(
      parseConnectionString(
        "mongodb",
        "mongodb+srv://reader:x@a.intern:27017,b.intern:27018/orders?replicaSet=rs0&authSource=admin&tls=true",
        MONGO,
      ),
    ).toEqual({
      ok: true,
      values: {
        user: "reader",
        database: "orders",
        hosts: "a.intern:27017,b.intern:27018",
        srv: true,
        replicaSet: "rs0",
        authSource: "admin",
        tls: true,
      },
      password: "x",
    });
  });

  it("refuse what has no field instead of dropping it", () => {
    expect(
      parseConnectionString("postgres", "postgres://h/d?application_name=x", POSTGRES),
    ).toEqual({ ok: false, error: "param", detail: "application_name" });
    expect(parseConnectionString("postgres", "postgres://h/d?sslmode=sometimes", POSTGRES)).toEqual(
      { ok: false, error: "value", detail: "sslmode" },
    );
    expect(parseConnectionString("postgres", "mysql://h/d", POSTGRES)).toEqual({
      ok: false,
      error: "scheme",
      detail: "mysql",
    });
    expect(parseConnectionString("postgres", "db.intern:5432", POSTGRES)).toEqual({
      ok: false,
      error: "format",
    });
  });

  it("write the fields back, the password only as the mask", () => {
    const values = {
      host: "db.intern",
      port: "5432",
      database: "shop",
      user: "kalzit_read",
      sslMode: "verify-full",
    };
    expect(toConnectionString("postgres", values, POSTGRES, MASK)).toBe(
      `postgres://kalzit_read:${MASK}@db.intern:5432/shop?sslmode=verify-full`,
    );
    expect(toConnectionString("postgres", values, POSTGRES, undefined)).toBe(
      "postgres://kalzit_read@db.intern:5432/shop?sslmode=verify-full",
    );
    expect(
      toConnectionString(
        "mongodb",
        { hosts: "a,b", srv: true, database: "o", user: "", tls: false, replicaSet: "" },
        MONGO,
        undefined,
      ),
    ).toBe("mongodb+srv://a,b/o");
  });

  it("leave out the auto TLS mode, which no driver knows, and keep it when read back", () => {
    const values = { host: "h", port: "1", database: "d", user: "u", sslMode: "auto" };
    const text = toConnectionString("postgres", values, POSTGRES, undefined);
    expect(text).toBe("postgres://u@h:1/d");
    expect(toConnectionString("mysql", values, MYSQL, undefined)).toBe("mysql://u@h:1/d");
    const read = parseConnectionString("postgres", text, POSTGRES);
    expect(read.ok && "sslMode" in read.values).toBe(false);
  });

  it("read back what they write", () => {
    const values = { host: "h", port: "1", database: "d b", user: "u", sslMode: "require" };
    const text = toConnectionString("postgres", values, POSTGRES, undefined);
    expect(parseConnectionString("postgres", text, POSTGRES)).toEqual({
      ok: true,
      values,
      password: undefined,
    });
  });
});

describe("form sections", () => {
  it("put each setting in its section, unknown ones under behavior", () => {
    expect(sectionOf("host")).toBe("connection");
    expect(sectionOf("password")).toBe("auth");
    expect(sectionOf("sslMode")).toBe("tls");
    expect(sectionOf("maxRows")).toBe("limits");
    expect(sectionOf("somethingNew")).toBe("behavior");
    expect(groupSettings(POSTGRES).map((group) => group.section)).toEqual([
      "connection",
      "auth",
      "tls",
      "limits",
    ]);
  });

  it("open connection, sign-in and any section with a required field", () => {
    expect(openAtFirst("connection", [])).toBe(true);
    expect(openAtFirst("tls", [spec("caCert", "text")])).toBe(false);
    expect(openAtFirst("behavior", [spec("x", "string", { required: true })])).toBe(true);
  });

  it("sum up a closed section's values", () => {
    const specs = [
      spec("sslMode", "select"),
      spec("encrypt", "bool"),
      spec("caCert", "text"),
      spec("token", "string", { secret: true }),
      spec("maxRows", "number"),
    ];
    expect(
      summarize(
        specs,
        {
          sslMode: "verify-full",
          encrypt: true,
          caCert: "-----BEGIN CERTIFICATE-----\nMII",
          maxRows: "",
        },
        (name) => name === "token",
      ),
    ).toEqual([
      { type: "value", text: "verify-full", mono: true },
      { type: "on", name: "encrypt" },
      { type: "value", text: "-----BEGIN CERTIFICATE-----", mono: true },
      { type: "secret", name: "token" },
    ]);
  });

  it("group the kinds of the picker", () => {
    expect(pickerGroup("postgres")).toBe("tables");
    expect(pickerGroup("sqlite")).toBe("tables");
    expect(pickerGroup("elasticsearch")).toBe("metricsSearch");
    expect(pickerGroup("tigergraph")).toBe("docsGraphs");
    expect(pickerGroup("http_json")).toBe("filesApis");
    expect(pickerGroup("new-kind")).toBe("other");
  });
});
