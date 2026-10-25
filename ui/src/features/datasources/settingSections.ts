import type { SettingSpec } from "./api";
import { kindFamily } from "./kindMarks";

/**
 * The sections of the settings form, in their order on the page. Each setting the server offers
 * belongs to one by its name; a setting this UI does not know yet lands in "behavior", so a new
 * server option shows without a UI change.
 */
export const SECTIONS = ["connection", "auth", "tls", "limits", "behavior"] as const;
export type Section = (typeof SECTIONS)[number];

const SECTION_OF: Readonly<Record<string, Section>> = {
  host: "connection",
  hosts: "connection",
  port: "connection",
  srv: "connection",
  replicaSet: "connection",
  database: "connection",
  path: "connection",
  url: "connection",
  restppUrl: "connection",
  graph: "connection",
  user: "auth",
  password: "auth",
  authSource: "auth",
  basicAuthUser: "auth",
  basicAuthPassword: "auth",
  bearerToken: "auth",
  apiKeyHeader: "auth",
  apiKey: "auth",
  secret: "auth",
  allowWriteCapableUser: "auth",
  sslMode: "tls",
  encrypt: "tls",
  tls: "tls",
  trustServerCertificate: "tls",
  caCert: "tls",
  maxRows: "limits",
  queryTimeoutSecs: "limits",
  maxResponseBytes: "limits",
  maxNodes: "limits",
  maxEdges: "limits",
};

export function sectionOf(name: string): Section {
  return Object.hasOwn(SECTION_OF, name) ? (SECTION_OF[name] as Section) : "behavior";
}

/** The kind's settings per section, each in the kind's own order; empty sections are left out. */
export function groupSettings(
  settings: readonly SettingSpec[],
): { section: Section; specs: SettingSpec[] }[] {
  return SECTIONS.map((section) => ({
    section,
    specs: settings.filter((spec) => sectionOf(spec.name) === section),
  })).filter((group) => group.specs.length > 0);
}

/**
 * Open at first: where the source is and who signs in, and any section with a required field.
 * The others are options and start closed, with their values summed up in the header.
 */
export function openAtFirst(section: Section, specs: readonly SettingSpec[]): boolean {
  return section === "connection" || section === "auth" || specs.some((spec) => spec.required);
}

/** One short piece of a closed section's summary. */
export type SummaryPart =
  | { type: "value"; text: string; mono: boolean }
  | { type: "on"; name: string }
  | { type: "secret"; name: string };

/**
 * What a closed section shows in its header: the values set, in order. Empty values are left
 * out; a switched-on option shows by its name, a stored or entered secret as "set".
 */
export function summarize(
  specs: readonly SettingSpec[],
  values: Readonly<Record<string, string | boolean>>,
  secretSet: (name: string) => boolean,
  /** Leave out values equal to the kind's default (Behavior: only what was changed). */
  skipDefaults = false,
): SummaryPart[] {
  const parts: SummaryPart[] = [];
  for (const spec of specs) {
    if (spec.secret) {
      if (secretSet(spec.name)) {
        parts.push({ type: "secret", name: spec.name });
      }
      continue;
    }
    const value = values[spec.name];
    if (skipDefaults && spec.default !== undefined) {
      const isDefault =
        spec.type === "bool"
          ? value === (spec.default === true)
          : String(value) === String(spec.default);
      if (isDefault) {
        continue;
      }
    }
    if (spec.type === "bool") {
      if (value === true) {
        parts.push({ type: "on", name: spec.name });
      }
      continue;
    }
    const text = String(value ?? "").trim();
    if (text === "") {
      continue;
    }
    if (spec.type === "text") {
      // A certificate or a list: its first line says enough.
      const first = text.split(/\r?\n/u)[0] ?? "";
      parts.push({
        type: "value",
        text: first.length > 32 ? `${first.slice(0, 32)}…` : first,
        mono: true,
      });
      continue;
    }
    parts.push({ type: "value", text, mono: spec.type !== "number" });
  }
  return parts;
}

/** The groups of the kind picker, in their order on the page. */
export const KIND_PICKER_GROUPS = [
  "tables",
  "metricsSearch",
  "docsGraphs",
  "filesApis",
  "other",
] as const;
export type KindPickerGroup = (typeof KIND_PICKER_GROUPS)[number];

export function pickerGroup(kind: string): KindPickerGroup {
  switch (kindFamily(kind)) {
    case "sql":
    case "sqlFile":
      return "tables";
    case "metrics":
    case "search":
      return "metricsSearch";
    case "documents":
    case "graph":
      return "docsGraphs";
    case "file":
    case "http":
      return "filesApis";
    default:
      return "other";
  }
}
