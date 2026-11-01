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

/**
 * Kalzit's own TLS mode (TLS required towards public addresses, preferred towards private ones):
 * no driver knows it, so a written string leaves `sslmode` out and reading it back keeps the field.
 */
const AUTO_TLS = "auto";

export function supportsConnectionString(kind: string): boolean {
  return Object.hasOwn(SCHEMES, kind);
}

export type ParseError =
  | "format"
  | "scheme"
  | "host"
  | "hostList"
  | "port"
  | "path"
  | "decode"
  | "param"
  | "value";

export type ParseResult =
  | {
      ok: true;
      /** Only what the string says; a parameter it leaves out leaves its field as it is. */
      values: Record<string, string | boolean>;
      /** The password in the string, or undefined when it has none. */
      password: string | undefined;
    }
  | { ok: false; error: ParseError; detail?: string };

/** scheme://authority/path?query, the authority taken apart below. */
const PATTERN = /^([a-z+]+):\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?$/iu;

/** One host with an optional port: a name, an IPv4 address or a bracketed IPv6 address. */
const HOST_PORT = /^(\[[0-9a-f:.]+\]|[^\s:[\],@]+)(?::(\d+))?$/iu;

function validPort(port: string | undefined): boolean {
  if (port === undefined) {
    return true;
  }
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

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
  const [, rawScheme = "", authority = "", rawPath, rawQuery] = match;
  const lowerScheme = rawScheme.toLowerCase();
  if (!scheme.schemes.includes(lowerScheme)) {
    return { ok: false, error: "scheme", detail: rawScheme };
  }
  // The login ends at the last "@": a password may hold an unescaped "@", a host never does.
  const at = authority.lastIndexOf("@");
  const userInfo = at === -1 ? undefined : authority.slice(0, at);
  const hostPart = at === -1 ? authority : authority.slice(at + 1);
  const colon = userInfo?.indexOf(":") ?? -1;
  const rawUser = userInfo === undefined ? "" : colon === -1 ? userInfo : userInfo.slice(0, colon);
  const rawPassword =
    userInfo === undefined || colon === -1 ? undefined : userInfo.slice(colon + 1);
  const user = decode(rawUser);
  if (user === null) {
    return { ok: false, error: "decode", detail: rawUser };
  }
  const password = rawPassword === undefined ? undefined : decode(rawPassword);
  if (password === null) {
    // The password itself is never echoed back.
    return { ok: false, error: "decode", detail: "password" };
  }
  const path = rawPath ?? "";
  if (path.includes("/")) {
    return { ok: false, error: "path", detail: `/${path}` };
  }
  const database = decode(path);
  if (database === null) {
    return { ok: false, error: "decode", detail: path };
  }
  if (hostPart === "") {
    return { ok: false, error: "host" };
  }
  const values: Record<string, string | boolean> = { user, database };
  if (kind === "mongodb") {
    for (const entry of hostPart.split(",")) {
      const hostPort = HOST_PORT.exec(entry);
      if (hostPort === null) {
        return { ok: false, error: "host", detail: entry };
      }
      if (!validPort(hostPort[2])) {
        return { ok: false, error: "port", detail: hostPort[2] ?? "" };
      }
    }
    values.hosts = hostPart;
    values.srv = lowerScheme === "mongodb+srv";
  } else {
    if (hostPart.includes(",")) {
      return { ok: false, error: "hostList", detail: hostPart };
    }
    const hostPort = HOST_PORT.exec(hostPart);
    if (hostPort === null) {
      return { ok: false, error: "host", detail: hostPart };
    }
    if (!validPort(hostPort[2])) {
      return { ok: false, error: "port", detail: hostPort[2] ?? "" };
    }
    values.host = (hostPort[1] ?? "").replace(/^\[|\]$/gu, "");
    const port = specs.find((spec) => spec.name === "port");
    values.port = hostPort[2] ?? (port?.default === undefined ? "" : String(port.default));
  }
  for (const pair of (rawQuery ?? "").split("&").filter(Boolean)) {
    // Only the first "=" separates; a value may hold more.
    const split = pair.indexOf("=");
    const rawKey = split === -1 ? pair : pair.slice(0, split);
    const rawValue = split === -1 ? "" : pair.slice(split + 1);
    const decodedKey = decode(rawKey);
    if (decodedKey === null) {
      return { ok: false, error: "decode", detail: rawKey };
    }
    const key = decodedKey.toLowerCase();
    const value = decode(rawValue);
    if (value === null) {
      return { ok: false, error: "decode", detail: key };
    }
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
    } else if (String(value ?? "") !== "" && value !== AUTO_TLS) {
      params.push(`${param}=${encodeURIComponent(String(value))}`);
    }
  }
  const path = database === "" ? "" : `/${encodeURIComponent(database)}`;
  return `${prefix}://${login}${authority}${path}${params.length > 0 ? `?${params.join("&")}` : ""}`;
}

/** Whether the fields name a host yet; without one a string would only mislead. */
export function hasHost(kind: string, values: Readonly<Record<string, string | boolean>>): boolean {
  return String(values[kind === "mongodb" ? "hosts" : "host"] ?? "").trim() !== "";
}

/** The fields the string covers for a kind; only these are replaced when it is read. */
export function connectionFields(kind: string): readonly string[] {
  return SCHEMES[kind]?.fields ?? [];
}
