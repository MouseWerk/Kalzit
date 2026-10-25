import type { SettingSpec } from "./api";

/**
 * A connection string for the kinds whose settings are exactly the parts of one: PostgreSQL,
 * MySQL / MariaDB and MongoDB. It is only another way to fill the same fields, both ways, in the
 * browser; the server still receives the fields. A parameter that has no field is refused rather
 * than dropped, so nothing the user wrote is silently lost.
 */
interface Scheme {
  schemes: readonly string[];
  /** The fields the string sets; anything else on the form stays as it is. */
  fields: readonly string[];
  /** Query parameters (lower case) and the field each one fills. */
  params: Readonly<Record<string, string>>;
}

const SCHEMES: Readonly<Record<string, Scheme>> = {
  postgres: {
    schemes: ["postgres", "postgresql"],
    fields: ["host", "port", "database", "user", "sslMode"],
    params: { sslmode: "sslMode" },
  },
  mysql: {
    schemes: ["mysql", "mariadb"],
    fields: ["host", "port", "database", "user", "sslMode"],
    params: { "ssl-mode": "sslMode", sslmode: "sslMode" },
  },
  mongodb: {
    schemes: ["mongodb", "mongodb+srv"],
    fields: ["hosts", "srv", "database", "user", "replicaSet", "authSource", "tls"],
    params: { replicaset: "replicaSet", authsource: "authSource", tls: "tls", ssl: "tls" },
  },
};

export function supportsConnectionString(kind: string): boolean {
  return Object.hasOwn(SCHEMES, kind);
}

export type ParseResult =
  | { ok: true; values: Record<string, string | boolean>; password: string | undefined }
  | { ok: false; error: "format" | "scheme" | "param" | "value"; detail?: string };

const PATTERN =
  /^([a-z+]+):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/iu;

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** Reads a string into field values (and the password, which goes to the secret). */
export function parseConnectionString(
  kind: string,
  text: string,
  specs: readonly SettingSpec[],
): ParseResult {
  const scheme = SCHEMES[kind];
  if (scheme === undefined) {
    return { ok: false, error: "scheme" };
  }
  const match = PATTERN.exec(text.trim());
  if (match === null) {
    return { ok: false, error: "format" };
  }
  const [, rawScheme = "", rawUser, rawPassword, authority = "", rawPath, rawQuery] = match;
  const lowerScheme = rawScheme.toLowerCase();
  if (!scheme.schemes.includes(lowerScheme)) {
    return { ok: false, error: "scheme", detail: rawScheme };
  }
  const values: Record<string, string | boolean> = {};
  const user = rawUser === undefined ? "" : decode(rawUser);
  const password = rawPassword === undefined ? undefined : decode(rawPassword);
  const database = rawPath === undefined ? "" : decode(rawPath);
  if (user === null || password === null || database === null) {
    return { ok: false, error: "format" };
  }
  values.user = user;
  values.database = database;
  if (kind === "mongodb") {
    values.hosts = authority;
    values.srv = lowerScheme === "mongodb+srv";
  } else {
    const hostPort = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u.exec(authority);
    if (hostPort === null) {
      return { ok: false, error: "format" };
    }
    values.host = (hostPort[1] ?? "").replace(/^\[|\]$/gu, "");
    const port = specs.find((spec) => spec.name === "port");
    values.port = hostPort[2] ?? (port?.default === undefined ? "" : String(port.default));
  }
  // Fields the string can set but leaves out go back to the kind's default.
  for (const field of Object.values(scheme.params)) {
    const spec = specs.find((candidate) => candidate.name === field);
    if (spec?.type === "bool") {
      values[field] = spec.default === true;
    } else {
      values[field] = spec?.default === undefined ? "" : String(spec.default);
    }
  }
  for (const pair of (rawQuery ?? "").split("&").filter(Boolean)) {
    const [rawKey = "", rawValue = ""] = pair.split("=");
    const key = decode(rawKey)?.toLowerCase() ?? "";
    const value = decode(rawValue) ?? "";
    const field = scheme.params[key];
    if (field === undefined) {
      return { ok: false, error: "param", detail: key };
    }
    const spec = specs.find((candidate) => candidate.name === field);
    if (spec?.type === "bool") {
      if (value !== "true" && value !== "false") {
        return { ok: false, error: "value", detail: key };
      }
      values[field] = value === "true";
    } else if (spec?.options !== undefined) {
      const option = spec.options.find((candidate) => candidate === value.toLowerCase());
      if (option === undefined) {
        return { ok: false, error: "value", detail: key };
      }
      values[field] = option;
    } else {
      values[field] = value;
    }
  }
  // Only the fields this kind has (a kind may lack one, such as a port).
  const known = new Set(specs.map((spec) => spec.name));
  return {
    ok: true,
    values: Object.fromEntries(Object.entries(values).filter(([field]) => known.has(field))),
    password,
  };
}

/** The mark for a password in a string that is shown: secrets are never written out. */
export const MASK = "••••••••";

/**
 * The fields as a string. `password` is the text to put in its place: the mask for a shown
 * string, nothing for one the user edits (the stored password is never read back).
 */
export function toConnectionString(
  kind: string,
  values: Readonly<Record<string, string | boolean>>,
  specs: readonly SettingSpec[],
  password: string | undefined,
): string {
  const scheme = SCHEMES[kind];
  if (scheme === undefined) {
    return "";
  }
  const text = (field: string) => String(values[field] ?? "").trim();
  const user = text("user");
  const login =
    user === ""
      ? ""
      : `${encodeURIComponent(user)}${password === undefined ? "" : `:${password}`}@`;
  let authority: string;
  let prefix = scheme.schemes[0] ?? kind;
  if (kind === "mongodb") {
    authority = text("hosts");
    if (values.srv === true) {
      prefix = "mongodb+srv";
    }
  } else {
    const host = text("host");
    const port = text("port");
    authority = `${host.includes(":") ? `[${host}]` : host}${port === "" ? "" : `:${port}`}`;
  }
  const database = text("database");
  const params: string[] = [];
  const written = new Set<string>();
  for (const [param, field] of Object.entries(scheme.params)) {
    if (written.has(field)) {
      continue;
    }
    written.add(field);
    const spec = specs.find((candidate) => candidate.name === field);
    if (spec === undefined) {
      continue;
    }
    const value = values[field];
    if (spec.type === "bool") {
      if (value === true) {
        params.push(`${param}=true`);
      }
    } else if (String(value ?? "") !== "") {
      params.push(`${param}=${encodeURIComponent(String(value))}`);
    }
  }
  const path = database === "" ? "" : `/${encodeURIComponent(database)}`;
  return `${prefix}://${login}${authority}${path}${params.length > 0 ? `?${params.join("&")}` : ""}`;
}

/** The fields the string covers for a kind; only these are replaced when it is read. */
export function connectionFields(kind: string): readonly string[] {
  return SCHEMES[kind]?.fields ?? [];
}
