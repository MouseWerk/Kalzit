/**
 * The panel message API, version 1 (docs/api/plugins.md, "Panel message API"), on the host side:
 * every event a panel's frame sends is checked here exactly as `kalzit_plugin_api::panel` checks
 * it, and only the checked event goes further, so unknown fields never pass. Both sides run the
 * cases of `plugin-api/panel/v1/events.fixture.json`; the limits are the Rust constants.
 */

export const API_VERSION = 1;
export const ENVELOPE = "panel";
export const MAX_EVENT_BYTES = 16 * 1024;
export const MAX_EVENTS_PER_SECOND = 20;
export const MAX_LOGS_PER_SECOND = 5;
export const MAX_SELECTED_ROWS = 1000;
export const MAX_VARIABLE_VALUES = 100;
export const MAX_VALUE_CHARS = 1024;
export const MIN_HEIGHT = 16;
export const MAX_HEIGHT = 4000;
export const MAX_URL_CHARS = 2048;
export const MAX_LINK_TITLE_CHARS = 200;
export const MAX_LOG_CHARS = 1024;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type PanelEvent =
  | { type: "ready" }
  | {
      type: "click";
      refId: string;
      target: "row" | "document" | "node" | "edge";
      index?: number;
      id?: string;
    }
  | { type: "select"; refId: string; rows: number[] }
  | { type: "range"; from: number; to: number }
  | { type: "setVariable"; name: string; value: string | string[] }
  | { type: "resize"; height: number }
  | { type: "setOptions"; options: Record<string, unknown> }
  | { type: "link"; url: string; title?: string }
  | { type: "log"; level: LogLevel; text: string };

export type Refusal = { code: string; message: string };
export type Parsed = { ok: true; event: PanelEvent } | ({ ok: false } & Refusal);

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function refuse(code: string, message: string): never {
  throw new Refused(code, message);
}

/** Control characters as Rust's `char::is_control` sees them (Unicode category Cc). */
const CONTROL = /\p{Cc}/u;

function chars(text: string): number {
  return [...text].length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(m: Record<string, unknown>, key: string, max: number): string {
  const value = m[key];
  if (typeof value === "string" && value !== "" && chars(value) <= max && !CONTROL.test(value)) {
    return value;
  }
  return refuse("panel.field_invalid", `${key} is a text of 1 to ${max} characters`);
}

/** A JSON whole number that is not negative (Rust's `as_u64`). */
function unsigned(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A JSON whole number (Rust's `as_i64`). */
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function variableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name);
}

/**
 * Whether a panel may ask to open `url`: an `http` or `https` address with a host and without a
 * user name, or a path in Kalzit (`/...`, not `//host` or `/\host`, and not Kalzit's API under
 * `/api`). Never another scheme.
 */
export function linkAllowed(url: string): boolean {
  if (url === "" || /[\s\p{Cc}\\]/u.test(url)) {
    return false;
  }
  if (url.startsWith("/")) {
    const first = url.slice(1).split(/[/?#]/, 1)[0] ?? "";
    return !url.startsWith("//") && first.toLowerCase() !== "api";
  }
  const lower = url.toLowerCase();
  const rest = lower.startsWith("https://")
    ? lower.slice(8)
    : lower.startsWith("http://")
      ? lower.slice(7)
      : null;
  if (rest === null) {
    return false;
  }
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  return authority !== "" && !authority.includes("@") && !authority.startsWith(":");
}

function parseObject(m: Record<string, unknown>): PanelEvent {
  if (m.kalzit !== ENVELOPE) {
    return refuse("panel.not_envelope", 'an event carries "kalzit": "panel"');
  }
  if (m.api !== API_VERSION) {
    return refuse("panel.api_unsupported", `this Kalzit speaks panel API ${API_VERSION}`);
  }
  const kind = typeof m.type === "string" ? m.type : "";
  switch (kind) {
    case "ready":
      return { type: "ready" };
    case "click": {
      const refId = text(m, "refId", 64);
      const target = m.target;
      if (target === "row" || target === "document") {
        if (m.index === undefined || m.index === null) {
          return refuse("panel.field_invalid", "index is required");
        }
        if (!unsigned(m.index)) {
          return refuse("panel.field_invalid", "index is a whole number");
        }
        return { type: "click", refId, target, index: m.index };
      }
      if (target === "node" || target === "edge") {
        return { type: "click", refId, target, id: text(m, "id", MAX_VALUE_CHARS) };
      }
      return refuse("panel.field_invalid", "target is row, document, node or edge");
    }
    case "select": {
      const refId = text(m, "refId", 64);
      const rows = m.rows;
      if (!Array.isArray(rows)) {
        return refuse("panel.field_invalid", "rows is a list");
      }
      if (rows.length > MAX_SELECTED_ROWS) {
        return refuse("panel.field_invalid", `at most ${MAX_SELECTED_ROWS} rows`);
      }
      if (!rows.every(unsigned)) {
        return refuse("panel.field_invalid", "rows are whole numbers");
      }
      return { type: "select", refId, rows: [...rows] };
    }
    case "range": {
      if (!integer(m.from) || !integer(m.to)) {
        return refuse("panel.field_invalid", "from and to are Unix milliseconds");
      }
      if (m.from >= m.to) {
        return refuse("panel.field_invalid", "from is before to");
      }
      return { type: "range", from: m.from, to: m.to };
    }
    case "setVariable": {
      const name = text(m, "name", 64);
      if (!variableName(name)) {
        return refuse("panel.field_invalid", "name is a variable name");
      }
      const check = (v: unknown): string => {
        if (typeof v === "string" && chars(v) <= MAX_VALUE_CHARS && !CONTROL.test(v)) {
          return v;
        }
        return refuse(
          "panel.field_invalid",
          `a value is a text of at most ${MAX_VALUE_CHARS} characters`,
        );
      };
      const value = m.value;
      if (Array.isArray(value)) {
        if (value.length > MAX_VARIABLE_VALUES) {
          return refuse("panel.field_invalid", `at most ${MAX_VARIABLE_VALUES} values`);
        }
        return { type: "setVariable", name, value: value.map(check) };
      }
      if (value === undefined) {
        return refuse("panel.field_invalid", "value is required");
      }
      return { type: "setVariable", name, value: check(value) };
    }
    case "resize": {
      const height = m.height;
      if (height !== undefined && height !== null && !unsigned(height)) {
        return refuse("panel.field_invalid", "height is a whole number");
      }
      if (unsigned(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT) {
        return { type: "resize", height };
      }
      return refuse("panel.field_invalid", `height is ${MIN_HEIGHT} to ${MAX_HEIGHT}`);
    }
    case "setOptions":
      if (!isRecord(m.options)) {
        return refuse("panel.field_invalid", "options is a JSON object");
      }
      return { type: "setOptions", options: m.options };
    case "link": {
      const url = text(m, "url", MAX_URL_CHARS);
      if (!linkAllowed(url)) {
        return refuse(
          "panel.field_invalid",
          "url is an http or https address without user name, or a path in Kalzit starting with /",
        );
      }
      if (m.title === undefined || m.title === null) {
        return { type: "link", url };
      }
      return { type: "link", url, title: text(m, "title", MAX_LINK_TITLE_CHARS) };
    }
    case "log": {
      const level = LOG_LEVELS.find((l) => l === m.level);
      if (level === undefined) {
        return refuse("panel.field_invalid", "level is debug, info, warn or error");
      }
      return { type: "log", level, text: text(m, "text", MAX_LOG_CHARS) };
    }
    default:
      return refuse(
        "panel.type_unknown",
        `${JSON.stringify(kind)} is not an event of panel API ${API_VERSION}`,
      );
  }
}

const encoder = new TextEncoder();

/** Checks an event as the frame sent it, as JSON text. */
export function parseEventText(message: string): Parsed {
  try {
    if (encoder.encode(message).length > MAX_EVENT_BYTES) {
      return refuse("panel.too_large", `an event is at most ${MAX_EVENT_BYTES} bytes`);
    }
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      return refuse("panel.not_json", "an event is JSON");
    }
    if (!isRecord(value)) {
      return refuse("panel.not_envelope", "an event is a JSON object");
    }
    return { ok: true, event: parseObject(value) };
  } catch (error) {
    if (error instanceof Refused) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * Checks an event as `postMessage` delivered it (a structured clone): written as JSON first, so
 * what is checked is what JSON can carry, then checked as text. Values JSON cannot write (a
 * cycle, a big integer) are refused as not JSON.
 */
export function parseEvent(data: unknown): Parsed {
  let message: string | undefined;
  try {
    message = JSON.stringify(data);
  } catch {
    message = undefined;
  }
  if (message === undefined) {
    return { ok: false, code: "panel.not_json", message: "an event is JSON" };
  }
  return parseEventText(message);
}

/**
 * Counts events per second; `take` says whether one more fits. One per panel for all events, one
 * for log lines.
 */
export class RateLimit {
  private second = -1;
  private count = 0;

  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  take(): boolean {
    const second = Math.floor(this.now() / 1000);
    if (second !== this.second) {
      this.second = second;
      this.count = 0;
    }
    if (this.count >= this.perSecond) {
      return false;
    }
    this.count += 1;
    return true;
  }
}

/** A message into the frame: the envelope and the type, then its fields. */
export function message(type: string, fields: Record<string, unknown> = {}) {
  return { kalzit: ENVELOPE, api: API_VERSION, type, ...fields };
}
